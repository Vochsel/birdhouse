import { openai } from "@ai-sdk/openai";
import { buildAuthHeaders, joinUrl } from "@birdhouse/client";
import {
  Contact,
  Message,
  OutboundMessageInput,
  ProviderCapability,
  ProviderKind,
  ProviderKindSchema,
  StreamEvent,
  StreamEventSchema
} from "@birdhouse/protocol";
import { streamText } from "ai";
import { spawn } from "node:child_process";

export interface ProviderSendInput {
  contact: Contact;
  threadId: string;
  message: OutboundMessageInput;
  history: Message[];
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly capability: ProviderCapability;
  sendMessageStream(input: ProviderSendInput): AsyncGenerator<StreamEvent>;
}

type CliParseMode = "text" | "json";

type CliProviderExtra = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: boolean;
  parse?: CliParseMode;
};

interface ResolvedCliCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  stdinText?: string;
  parse: CliParseMode;
}

const DEFAULT_CLI_TIMEOUT_MS = 180_000;

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRole(role: Message["role"]): "user" | "assistant" | "system" {
  if (role === "agent") {
    return "assistant";
  }

  if (role === "system") {
    return "system";
  }

  return "user";
}

function buildAttachmentContext(message: OutboundMessageInput): string {
  if (!message.attachments.length) {
    return "";
  }

  const summary = message.attachments
    .map((attachment) => `${attachment.kind}:${attachment.name}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`)
    .join(", ");

  return `\n\nAttachments: ${summary}`;
}

function getPrompt(input: ProviderSendInput): string {
  return `${input.message.text}${buildAttachmentContext(input.message)}`;
}

function parseCliExtra(contact: Contact): CliProviderExtra {
  const extra = contact.provider.extra;

  const parsed: CliProviderExtra = {};

  if (typeof extra.command === "string" && extra.command.trim().length > 0) {
    parsed.command = extra.command.trim();
  }

  if (Array.isArray(extra.args) && extra.args.every((item) => typeof item === "string")) {
    parsed.args = extra.args;
  }

  if (typeof extra.cwd === "string" && extra.cwd.trim().length > 0) {
    parsed.cwd = extra.cwd.trim();
  }

  if (typeof extra.timeoutMs === "number" && Number.isFinite(extra.timeoutMs) && extra.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(extra.timeoutMs);
  }

  if (typeof extra.stdin === "boolean") {
    parsed.stdin = extra.stdin;
  }

  if (extra.parse === "text" || extra.parse === "json") {
    parsed.parse = extra.parse;
  }

  if (extra.env && typeof extra.env === "object" && !Array.isArray(extra.env)) {
    const envEntries = Object.entries(extra.env)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .map(([key, value]) => [key, value]);

    parsed.env = Object.fromEntries(envEntries);
  }

  return parsed;
}

function parseStringArrayEnv(value: string | undefined): string[] | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Ignore invalid env input and fall back to defaults.
  }

  return null;
}

function applyPromptToArgs(args: string[], prompt: string, appendPromptIfMissing: boolean): string[] {
  let hasPlaceholder = false;
  const resolved = args.map((arg) => {
    if (arg.includes("{prompt}")) {
      hasPlaceholder = true;
      return arg.replaceAll("{prompt}", prompt);
    }

    return arg;
  });

  if (appendPromptIfMissing && !hasPlaceholder) {
    resolved.push(prompt);
  }

  return resolved;
}

async function runCliCommand(command: ResolvedCliCommand): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        ...command.env
      },
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
      reject(new Error(`CLI command timed out after ${command.timeoutMs}ms: ${command.command}`));
    }, command.timeoutMs);

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
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0
      });
    });

    if (command.stdinText && command.stdinText.length > 0) {
      child.stdin.write(command.stdinText);
    }

    child.stdin.end();
  });
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractTextFromUnknown(item)).filter(Boolean).join("\n").trim();
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    const preferredKeys = ["text", "message", "output", "response", "result", "completion", "content"];
    for (const key of preferredKeys) {
      const direct = obj[key];
      const text = extractTextFromUnknown(direct);
      if (text) {
        return text;
      }
    }

    const nested = Object.values(obj)
      .map((item) => extractTextFromUnknown(item))
      .find((item) => item.length > 0);

    return nested ?? "";
  }

  return "";
}

function normalizeCliOutput(stdout: string, stderr: string, parseMode: CliParseMode): string {
  const trimmedStdout = stdout.trim();

  if (parseMode === "json" && trimmedStdout.length > 0) {
    try {
      const parsed = JSON.parse(trimmedStdout);
      const text = extractTextFromUnknown(parsed).trim();
      if (text) {
        return text;
      }
    } catch {
      const lines = trimmedStdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const parts: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const text = extractTextFromUnknown(parsed).trim();
          if (text) {
            parts.push(text);
          }
        } catch {
          // Ignore lines that are not JSON when json mode is requested.
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

function chunkText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return [trimmed];
  }

  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

async function *parseSseEvents(response: Response): AsyncGenerator<StreamEvent> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const normalized = buffer.replace(/\r\n/g, "\n");
      const boundary = normalized.indexOf("\n\n");
      if (boundary < 0) {
        break;
      }

      const rawEvent = normalized.slice(0, boundary);
      buffer = normalized.slice(boundary + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const payload of dataLines) {
        if (payload === "[DONE]") {
          continue;
        }

        try {
          const parsedJson = JSON.parse(payload);
          const parsedEvent = StreamEventSchema.safeParse(parsedJson);

          if (parsedEvent.success) {
            yield parsedEvent.data;
            continue;
          }

          if (typeof parsedJson?.text === "string") {
            yield {
              type: "token",
              text: parsedJson.text
            };
            continue;
          }

          if (typeof parsedJson?.token === "string") {
            yield {
              type: "token",
              text: parsedJson.token
            };
            continue;
          }
        } catch {
          yield {
            type: "token",
            text: payload
          };
          continue;
        }
      }
    }
  }
}

function getRemotePath(contact: Contact, defaultPath: string): string {
  const path = contact.provider.extra.path;
  if (typeof path === "string" && path.startsWith("/")) {
    return path;
  }

  return defaultPath;
}

async function *streamRemoteProvider(contact: Contact, payload: Record<string, unknown>, defaultPath: string): AsyncGenerator<StreamEvent> {
  const response = await fetch(joinUrl(contact.provider.baseUrl, getRemotePath(contact, defaultPath)), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      ...buildAuthHeaders(contact.provider.auth)
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Remote provider request failed (${response.status}): ${responseText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for await (const event of parseSseEvents(response)) {
      yield event;
    }
    return;
  }

  const body = await response.json();
  const text =
    typeof body?.text === "string"
      ? body.text
      : typeof body?.message === "string"
        ? body.message
        : typeof body?.output === "string"
          ? body.output
          : "";

  const messageId = randomId();
  const createdAt = new Date().toISOString();

  yield {
    type: "message_start",
    messageId,
    threadId: String(payload.threadId ?? "thread"),
    createdAt
  };
  if (text.length > 0) {
    yield {
      type: "token",
      text
    };
  }
  yield {
    type: "message_end",
    messageId,
    text,
    status: "received",
    createdAt
  };
}

export class AiSdkProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = "ai-sdk";

  readonly capability: ProviderCapability = {
    kind: "ai-sdk",
    supportsStreaming: true,
    supportsAttachments: true,
    supportsAsync: true
  };

  constructor(private readonly model: string = process.env.OPENAI_MODEL ?? "gpt-4.1-mini") {}

  async *sendMessageStream(input: ProviderSendInput): AsyncGenerator<StreamEvent> {
    const messageId = randomId();
    const createdAt = new Date().toISOString();

    yield {
      type: "message_start",
      messageId,
      threadId: input.threadId,
      createdAt
    };

    yield {
      type: "typing",
      isTyping: true
    };

    const historyMessages = input.history.map((message) => ({
      role: normalizeRole(message.role),
      content: message.text
    }));

    const prompt = getPrompt(input);

    const result = streamText({
      model: openai(this.model) as any,
      messages: [...historyMessages, { role: "user", content: prompt }] as any
    });

    let fullText = "";
    for await (const token of result.textStream) {
      fullText += token;
      yield {
        type: "token",
        text: token
      };
    }

    yield {
      type: "typing",
      isTyping: false
    };

    yield {
      type: "message_end",
      messageId,
      text: fullText,
      status: "received",
      createdAt: new Date().toISOString()
    };
  }
}

export class OpenClawProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = "openclaw";

  readonly capability: ProviderCapability = {
    kind: "openclaw",
    supportsStreaming: true,
    supportsAttachments: true,
    supportsAsync: true
  };

  async *sendMessageStream(input: ProviderSendInput): AsyncGenerator<StreamEvent> {
    const payload = {
      threadId: input.threadId,
      message: input.message,
      history: input.history,
      metadata: input.metadata ?? {},
      stream: true
    };

    for await (const event of streamRemoteProvider(input.contact, payload, "/chat")) {
      yield event;
    }
  }
}

export class PiMonoProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = "pi-mono";

  readonly capability: ProviderCapability = {
    kind: "pi-mono",
    supportsStreaming: true,
    supportsAttachments: true,
    supportsAsync: true
  };

  async *sendMessageStream(input: ProviderSendInput): AsyncGenerator<StreamEvent> {
    const payload = {
      threadId: input.threadId,
      input: {
        text: input.message.text,
        attachments: input.message.attachments
      },
      history: input.history,
      metadata: input.metadata ?? {},
      stream: true
    };

    for await (const event of streamRemoteProvider(input.contact, payload, "/api/chat")) {
      yield event;
    }
  }
}

class CliWrappedProviderAdapter implements ProviderAdapter {
  readonly capability: ProviderCapability;

  constructor(
    readonly kind: ProviderKind,
    private readonly defaultCommand: string | null,
    private readonly defaultArgs: string[],
    private readonly defaultParse: CliParseMode
  ) {
    this.capability = {
      kind,
      supportsStreaming: true,
      supportsAttachments: false,
      supportsAsync: false
    };
  }

  private resolveCommand(input: ProviderSendInput): ResolvedCliCommand {
    const extra = parseCliExtra(input.contact);
    const command = extra.command ?? this.defaultCommand ?? undefined;

    if (!command) {
      throw new Error(
        `${this.kind} requires provider.extra.command. Example: {"command":"nanoclaw","args":["{prompt}"]}`
      );
    }

    const prompt = getPrompt(input);
    const stdinMode = Boolean(extra.stdin);

    const rawArgs = extra.args ?? this.defaultArgs;
    const args = applyPromptToArgs(rawArgs, prompt, !stdinMode);

    return {
      command,
      args,
      cwd: extra.cwd,
      env: extra.env,
      timeoutMs: extra.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      stdinText: stdinMode ? prompt : undefined,
      parse: extra.parse ?? this.defaultParse
    };
  }

  async *sendMessageStream(input: ProviderSendInput): AsyncGenerator<StreamEvent> {
    const messageId = randomId();
    const createdAt = new Date().toISOString();

    yield {
      type: "message_start",
      messageId,
      threadId: input.threadId,
      createdAt
    };

    yield {
      type: "typing",
      isTyping: true
    };

    const command = this.resolveCommand(input);
    const result = await runCliCommand(command);

    if (result.exitCode !== 0) {
      const errorText = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`${this.kind} command failed: ${errorText}`);
    }

    const text = normalizeCliOutput(result.stdout, result.stderr, command.parse);

    for (const chunk of chunkText(text)) {
      yield {
        type: "token",
        text: chunk
      };
    }

    yield {
      type: "typing",
      isTyping: false
    };

    yield {
      type: "message_end",
      messageId,
      text,
      status: "received",
      createdAt: new Date().toISOString()
    };
  }
}

export class ClaudeCodeCliProviderAdapter extends CliWrappedProviderAdapter {
  constructor() {
    super("claude-code-cli", process.env.BIRDHOUSE_CLAUDE_CODE_COMMAND ?? "claude", ["-p", "{prompt}"], "text");
  }
}

export class TerminalCliProviderAdapter extends CliWrappedProviderAdapter {
  constructor() {
    const configuredArgs = parseStringArrayEnv(process.env.BIRDHOUSE_TERMINAL_CLI_ARGS);
    super(
      "terminal-cli",
      process.env.BIRDHOUSE_TERMINAL_CLI_COMMAND ?? process.env.BIRDHOUSE_CODEX_COMMAND ?? "codex",
      configuredArgs ?? ["exec", "{prompt}"],
      "text"
    );
  }
}

export class OpenClawCliProviderAdapter extends CliWrappedProviderAdapter {
  constructor() {
    super(
      "openclaw-cli",
      process.env.BIRDHOUSE_OPENCLAW_COMMAND ?? "openclaw",
      ["--no-color", "agent", "--message", "{prompt}"],
      "text"
    );
  }
}

export class NanoClawCliProviderAdapter extends CliWrappedProviderAdapter {
  constructor() {
    super("nanoclaw-cli", process.env.BIRDHOUSE_NANOCLAW_COMMAND ?? null, ["{prompt}"], "text");
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.kind, adapter);
    }
  }

  get(kind: ProviderKind): ProviderAdapter {
    const parsedKind = ProviderKindSchema.parse(kind);
    const adapter = this.adapters.get(parsedKind);

    if (!adapter) {
      throw new Error(`No provider adapter registered for kind: ${kind}`);
    }

    return adapter;
  }

  capabilities(): ProviderCapability[] {
    return Array.from(this.adapters.values()).map((adapter) => adapter.capability);
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    new AiSdkProviderAdapter(),
    new OpenClawProviderAdapter(),
    new PiMonoProviderAdapter(),
    new TerminalCliProviderAdapter(),
    new ClaudeCodeCliProviderAdapter(),
    new OpenClawCliProviderAdapter(),
    new NanoClawCliProviderAdapter()
  ]);
}
