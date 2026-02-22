#!/usr/bin/env node

import { serve } from "@hono/node-server";
import {
  AsyncScheduleRequestSchema,
  AsyncTriggerRequest,
  AsyncTriggerRequestSchema,
  Attachment,
  ChatStreamRequest,
  ChatStreamRequestSchema,
  Contact,
  ProviderCapability,
  ProviderKind,
  ProviderKindSchema,
  PushRegistrationSchema,
  StreamEvent
} from "@birdhouse/protocol";
import { createDefaultProviderRegistry } from "@birdhouse/provider-sdk";
import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type WrappedCommandConfig = {
  command: string;
  baseArgs: string[];
  timeoutMs: number;
  stdin: boolean;
  parse: "text" | "json";
  inferredKind: ProviderKind;
};

type ParsedServerCliArgs = {
  argv: string[];
  portOverride: number | null;
};

const serverDir = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(serverDir, "../../../.env");

// Load repo-root .env first so the server works even when launched from subdirectories.
loadEnv({ path: rootEnvPath });
loadEnv();

const registry = createDefaultProviderRegistry();
const app = new Hono();

app.use("*", cors());

const pushRegistry = new Map<string, Set<string>>();
const scheduledJobs = new Map<string, ReturnType<typeof setTimeout>>();

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getPushRegistryKey(contactId: string, threadId: string): string {
  return `${contactId}:${threadId}`;
}

function registerPushToken(contactId: string, threadId: string, token: string): void {
  const key = getPushRegistryKey(contactId, threadId);
  const existing = pushRegistry.get(key) ?? new Set<string>();
  existing.add(token);
  pushRegistry.set(key, existing);
}

function inferWrappedKind(command: string): ProviderKind {
  const normalized = command.toLowerCase();

  if (normalized.includes("claude")) {
    return "claude-code-cli";
  }

  if (normalized.includes("openclaw")) {
    return "openclaw-cli";
  }

  if (normalized.includes("nano")) {
    return "nanoclaw-cli";
  }

  return "terminal-cli";
}

function parsePortValue(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid value for ${flagName}: ${value}. Expected an integer between 1 and 65535.`);
  }

  return parsed;
}

function isCodexCommand(command: string): boolean {
  const leaf = command.split(/[\\/]/).pop() ?? command;
  return leaf.toLowerCase() === "codex" || leaf.toLowerCase().startsWith("codex.");
}

function parseServerCliArgs(rawArgv: string[]): ParsedServerCliArgs {
  const argv: string[] = [];
  let portOverride: number | null = null;

  for (let index = 0; index < rawArgv.length; index += 1) {
    const token = rawArgv[index];

    if (token === "--") {
      argv.push(...rawArgv.slice(index));
      break;
    }

    if (token === "--port" || token === "-p") {
      const next = rawArgv[index + 1];
      if (!next) {
        throw new Error(`${token} requires a value.`);
      }

      portOverride = parsePortValue(next, token);
      index += 1;
      continue;
    }

    if (token.startsWith("--port=")) {
      portOverride = parsePortValue(token.slice("--port=".length), "--port");
      continue;
    }

    argv.push(token);
  }

  return {
    argv,
    portOverride
  };
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function shouldShowServerHelp(argv: string[]): boolean {
  const separatorIndex = argv.indexOf("--");

  if (separatorIndex === -1) {
    return argv.some(isHelpFlag);
  }

  const trailing = argv.slice(separatorIndex + 1);
  if (trailing.length === 1 && isHelpFlag(trailing[0])) {
    return true;
  }

  if (trailing.length === 0 && argv.some(isHelpFlag)) {
    return true;
  }

  return false;
}

function printServerHelp(): void {
  const helpText = [
    "birdhouse-server",
    "",
    "Usage:",
    "  ./birdhouse-server --help",
    "  ./birdhouse-server [--port <port>]",
    "  ./birdhouse-server [--port <port>] -- <command> [args...]",
    "",
    "Modes:",
    "  provider-registry (default):",
    "    Uses configured provider adapters (ai-sdk/openclaw/pi-mono/cli wrappers).",
    "    Listens on PORT (default 8787).",
    "",
    "  wrapped-command (with -- <command>):",
    "    Runs one command per server instance and wraps it behind /v1/chat.stream.",
    "    Uses auto-assigned free port unless BIRDHOUSE_SERVER_PORT is set.",
    "    For bare `codex`, defaults to `codex exec {prompt}` to avoid TTY-only interactive mode.",
    "",
    "Examples:",
    "  ./birdhouse-server",
    "  ./birdhouse-server -- claude",
    "  ./birdhouse-server -- openclaw --no-color agent",
    "  ./birdhouse-server -- codex",
    "",
    "Options:",
    "  --port, -p                 Explicit server port (overrides env)",
    "",
    "Environment:",
    "  PORT                        Default server port in provider-registry mode",
    "  BIRDHOUSE_DEFAULT_PROVIDER  Preferred provider kind for /v1/providers/default",
    "  BIRDHOUSE_SERVER_PORT       Fixed port in wrapped-command mode",
    "  BIRDHOUSE_SERVER_TIMEOUT_MS Wrapped command timeout (default 180000)",
    "  BIRDHOUSE_SERVER_STDIN      Set to 1 to send prompt via stdin",
    "  BIRDHOUSE_SERVER_PARSE      Set to json to parse wrapped output as JSON",
    "  BIRDHOUSE_TERMINAL_CLI_COMMAND  Default command for terminal-cli adapter",
    "  BIRDHOUSE_TERMINAL_CLI_ARGS     JSON string array for terminal-cli default args",
    ""
  ].join("\n");

  console.log(helpText);
}

let parsedCliArgs: ParsedServerCliArgs;
try {
  parsedCliArgs = parseServerCliArgs(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to parse CLI arguments.";
  console.error(`birdhouse-server argument error: ${message}`);
  process.exit(1);
}

if (shouldShowServerHelp(parsedCliArgs.argv)) {
  printServerHelp();
  process.exit(0);
}

function parseWrappedCommandConfig(argv: string[]): WrappedCommandConfig | null {
  let commandArgs = argv;
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex >= 0) {
    commandArgs = argv.slice(separatorIndex + 1);
  }

  if (commandArgs.length === 0) {
    return null;
  }

  // If no separator was provided, ignore flag-like arguments to preserve existing usage.
  if (separatorIndex === -1 && commandArgs[0].startsWith("-")) {
    return null;
  }

  const command = commandArgs[0];
  let baseArgs = commandArgs.slice(1);
  if (baseArgs.length === 0 && isCodexCommand(command)) {
    // Bare `codex` expects an interactive TTY; use non-interactive mode by default.
    baseArgs = ["exec", "{prompt}"];
  }
  const timeoutMs = Number(
    process.env.BIRDHOUSE_SERVER_TIMEOUT_MS ??
      process.env.BIRDHOUSE_WRAPPED_TIMEOUT_MS ??
      "180000"
  );
  const stdin =
    process.env.BIRDHOUSE_SERVER_STDIN === "1" ||
    process.env.BIRDHOUSE_WRAPPED_STDIN === "1";
  const parse =
    process.env.BIRDHOUSE_SERVER_PARSE === "json" ||
    process.env.BIRDHOUSE_WRAPPED_PARSE === "json"
      ? "json"
      : "text";

  return {
    command,
    baseArgs,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 180000,
    stdin,
    parse,
    inferredKind: inferWrappedKind(command)
  };
}

const wrappedCommand = parseWrappedCommandConfig(parsedCliArgs.argv);

function summarizeAttachments(attachments: Attachment[]): string {
  if (!attachments.length) {
    return "";
  }

  const items = attachments.map((attachment) => {
    return `${attachment.kind}:${attachment.name}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`;
  });

  return `\n\nAttachments: ${items.join(", ")}`;
}

function applyPrompt(args: string[], prompt: string, stdinMode: boolean): string[] {
  let hasPlaceholder = false;

  const replaced = args.map((arg) => {
    if (arg.includes("{prompt}")) {
      hasPlaceholder = true;
      return arg.replaceAll("{prompt}", prompt);
    }

    return arg;
  });

  if (!stdinMode && !hasPlaceholder) {
    replaced.push(prompt);
  }

  return replaced;
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractTextFromUnknown(item)).filter(Boolean).join("\n").trim();
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    for (const key of ["text", "message", "output", "response", "result", "completion", "content"]) {
      const text = extractTextFromUnknown(record[key]);
      if (text) {
        return text;
      }
    }

    for (const nested of Object.values(record)) {
      const text = extractTextFromUnknown(nested);
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function normalizeWrappedOutput(stdout: string, stderr: string, parse: "text" | "json"): string {
  const trimmedStdout = stdout.trim();

  if (parse === "json" && trimmedStdout.length > 0) {
    try {
      const parsed = JSON.parse(trimmedStdout);
      const extracted = extractTextFromUnknown(parsed).trim();
      if (extracted) {
        return extracted;
      }
    } catch {
      const parts: string[] = [];
      for (const line of trimmedStdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed);
          const extracted = extractTextFromUnknown(parsed).trim();
          if (extracted) {
            parts.push(extracted);
          }
        } catch {
          // Ignore non-JSON lines in json parse mode.
        }
      }

      if (parts.length > 0) {
        return parts.join("\n");
      }
    }
  }

  if (trimmedStdout.length > 0) {
    return trimmedStdout;
  }

  return stderr.trim();
}

async function runWrappedCommandPrompt(prompt: string): Promise<string> {
  if (!wrappedCommand) {
    throw new Error("Wrapped command mode is not active.");
  }

  const args = applyPrompt(wrappedCommand.baseArgs, prompt, wrappedCommand.stdin);

  return new Promise((resolve, reject) => {
    const child = spawn(wrappedCommand.command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let completed = false;

    const timer = setTimeout(() => {
      if (completed) {
        return;
      }

      completed = true;
      child.kill("SIGTERM");
      reject(new Error(`Wrapped command timed out after ${wrappedCommand.timeoutMs}ms`));
    }, wrappedCommand.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);

      if ((code ?? 0) !== 0) {
        const message = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(message));
        return;
      }

      resolve(normalizeWrappedOutput(stdout, stderr, wrappedCommand.parse));
    });

    if (wrappedCommand.stdin) {
      child.stdin.write(prompt);
    }

    child.stdin.end();
  });
}

async function *runWrappedCommandStream(request: ChatStreamRequest): AsyncGenerator<StreamEvent> {
  const messageId = randomId();
  const createdAt = new Date().toISOString();

  yield {
    type: "message_start",
    messageId,
    threadId: request.threadId,
    createdAt
  };

  yield {
    type: "typing",
    isTyping: true
  };

  const prompt = `${request.message.text}${summarizeAttachments(request.message.attachments)}`;
  const output = await runWrappedCommandPrompt(prompt);

  if (output.length > 0) {
    for (const line of output.split(/\r?\n/)) {
      if (!line.length) {
        continue;
      }

      yield {
        type: "token",
        text: `${line}\n`
      };
    }
  }

  yield {
    type: "typing",
    isTyping: false
  };

  yield {
    type: "message_end",
    messageId,
    text: output,
    status: "received",
    createdAt: new Date().toISOString()
  };
}

async function *runProviderStream(request: ChatStreamRequest): AsyncGenerator<StreamEvent> {
  if (wrappedCommand) {
    for await (const event of runWrappedCommandStream(request)) {
      yield event;
    }
    return;
  }

  const adapter = registry.get(request.contact.provider.kind);
  for await (const event of adapter.sendMessageStream({
    contact: request.contact,
    threadId: request.threadId,
    message: request.message,
    history: request.history,
    metadata: request.metadata
  })) {
    yield event;
  }
}

function commandCapabilities(): ProviderCapability[] {
  if (!wrappedCommand) {
    return registry.capabilities();
  }

  return [
    {
      kind: wrappedCommand.inferredKind,
      supportsStreaming: true,
      supportsAttachments: false,
      supportsAsync: true
    }
  ];
}

function hasOpenAiApiKey(): boolean {
  const apiKey = process.env.OPENAI_API_KEY;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function defaultProviderKind(): ProviderKind | null {
  if (wrappedCommand) {
    return wrappedCommand.inferredKind;
  }

  const capabilities = registry.capabilities();
  if (!capabilities.length) {
    return null;
  }

  const configuredDefault = process.env.BIRDHOUSE_DEFAULT_PROVIDER;
  if (configuredDefault) {
    const parsed = ProviderKindSchema.safeParse(configuredDefault);
    if (parsed.success && capabilities.some((capability) => capability.kind === parsed.data)) {
      return parsed.data;
    }
  }

  const aiSdk = capabilities.find((capability) => capability.kind === "ai-sdk");
  if (aiSdk && hasOpenAiApiKey()) {
    return aiSdk.kind;
  }

  const terminalCli = capabilities.find((capability) => capability.kind === "terminal-cli");
  if (terminalCli) {
    return terminalCli.kind;
  }

  if (aiSdk) {
    return aiSdk.kind;
  }

  return capabilities[0].kind;
}

async function sendExpoPush(tokens: string[], title: string, body: string, data: Record<string, unknown>): Promise<void> {
  if (!tokens.length) {
    return;
  }

  const notifications = tokens.map((to) => ({
    to,
    sound: "default",
    title,
    body,
    data
  }));

  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(notifications)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Expo push failed (${response.status}): ${message}`);
  }
}

async function generateAgentText(contact: Contact, threadId: string, text?: string): Promise<string> {
  if (text && text.trim().length > 0) {
    return text.trim();
  }

  if (wrappedCommand) {
    const output = await runWrappedCommandPrompt("Send a short async follow-up message in one sentence.");
    return output.trim() || "Quick follow-up from your agent.";
  }

  const adapter = registry.get(contact.provider.kind);
  const stream = adapter.sendMessageStream({
    contact,
    threadId,
    message: {
      text: "Send a short async follow-up message in one sentence.",
      attachments: []
    },
    history: []
  });

  let collected = "";
  for await (const event of stream) {
    if (event.type === "token") {
      collected += event.text;
    }
  }

  return collected.trim() || "Quick follow-up from your agent.";
}

async function dispatchAsyncMessage(input: AsyncTriggerRequest): Promise<{ deliveredTo: number; text: string }> {
  const text = await generateAgentText(input.contact, input.threadId, input.text);

  const key = getPushRegistryKey(input.contact.id, input.threadId);
  const tokens = Array.from(pushRegistry.get(key) ?? []);

  await sendExpoPush(tokens, input.contact.displayName, text, {
    contactId: input.contact.id,
    threadId: input.threadId,
    text,
    timestamp: new Date().toISOString()
  });

  return {
    deliveredTo: tokens.length,
    text
  };
}

app.get("/v1/health", (c) => {
  const defaultProvider = defaultProviderKind();
  return c.json({
    ok: true,
    service: "birdhouse-agent-server",
    mode: wrappedCommand ? "wrapped-command" : "provider-registry",
    defaultProvider,
    wrappedCommand: wrappedCommand
      ? {
          command: wrappedCommand.command,
          args: wrappedCommand.baseArgs
        }
      : null,
    now: new Date().toISOString()
  });
});

app.get("/v1/providers/capabilities", (c) => {
  return c.json({
    capabilities: commandCapabilities()
  });
});

app.get("/v1/providers/default", (c) => {
  const kind = defaultProviderKind();
  if (!kind) {
    return c.json(
      {
        error: "no_provider",
        message: "No provider is available on this endpoint."
      },
      503
    );
  }

  return c.json({ kind });
});

app.post("/v1/push/register", async (c) => {
  const json = await c.req.json();
  const registration = PushRegistrationSchema.parse(json);

  registerPushToken(registration.contactId, registration.threadId, registration.expoPushToken);

  return c.json({
    ok: true,
    contactId: registration.contactId,
    threadId: registration.threadId
  });
});

app.post("/v1/chat.stream", async (c) => {
  const json = await c.req.json();
  const request = ChatStreamRequestSchema.parse(json);

  return streamSSE(c, async (stream) => {
    try {
      for await (const event of runProviderStream(request)) {
        await stream.writeSSE({
          data: JSON.stringify(event)
        });
      }

      await stream.writeSSE({
        data: "[DONE]"
      });
    } catch (error) {
      const event: StreamEvent = {
        type: "error",
        code: "provider_error",
        message: error instanceof Error ? error.message : "Unknown provider error",
        retryable: false
      };

      await stream.writeSSE({
        data: JSON.stringify(event)
      });
    }
  });
});

app.post("/v1/async/trigger", async (c) => {
  const json = await c.req.json();
  const request = AsyncTriggerRequestSchema.parse(json);

  const result = await dispatchAsyncMessage(request);

  return c.json({
    queued: true,
    deliveredTo: result.deliveredTo,
    text: result.text
  });
});

app.post("/v1/async/schedule", async (c) => {
  const json = await c.req.json();
  const request = AsyncScheduleRequestSchema.parse(json);

  const jobId = randomId();
  const timer = setTimeout(async () => {
    try {
      await dispatchAsyncMessage({
        contact: request.contact,
        threadId: request.threadId,
        text: request.text
      });
    } catch (error) {
      console.error("Failed to dispatch scheduled async message", error);
    } finally {
      scheduledJobs.delete(jobId);
    }
  }, request.delaySeconds * 1000);

  scheduledJobs.set(jobId, timer);

  return c.json({
    scheduled: true,
    jobId,
    delaySeconds: request.delaySeconds,
    runAt: new Date(Date.now() + request.delaySeconds * 1000).toISOString()
  });
});

app.onError((error, c) => {
  console.error(error);
  return c.json(
    {
      error: "server_error",
      message: error instanceof Error ? error.message : "Unknown error"
    },
    500
  );
});

const envPort = process.env.PORT ? Number(process.env.PORT) : NaN;
const serverPort = process.env.BIRDHOUSE_SERVER_PORT ? Number(process.env.BIRDHOUSE_SERVER_PORT) : NaN;
const cliPort = parsedCliArgs.portOverride;
const port = cliPort
  ? cliPort
  : wrappedCommand
    ? Number.isFinite(serverPort) && serverPort > 0
      ? serverPort
      : 0
    : Number.isFinite(envPort) && envPort > 0
      ? envPort
      : 8787;

serve(
  {
    fetch: app.fetch,
    port
  },
  (info) => {
    if (wrappedCommand) {
      const renderedArgs = wrappedCommand.baseArgs.length ? ` ${wrappedCommand.baseArgs.join(" ")}` : "";
      console.log(`birdhouse-server wrapping: ${wrappedCommand.command}${renderedArgs}`);
      if (
        Number.isFinite(envPort) &&
        envPort > 0 &&
        !(Number.isFinite(serverPort) && serverPort > 0) &&
        !cliPort
      ) {
        console.log(
          "birdhouse-server note: ignoring PORT in wrapped mode; set BIRDHOUSE_SERVER_PORT to force a fixed port."
        );
      }
    }

    if (cliPort) {
      console.log(`birdhouse-server port override (--port): ${cliPort}`);
    }

    console.log(`birdhouse agent server running on http://localhost:${info.port}`);
  }
);
