#!/usr/bin/env node

import { createBirdhouseClient } from "@birdhouse/client";
import type { Attachment, AuthConfig, Contact, Message, ProviderKind } from "@birdhouse/protocol";
import { program } from "commander";
import { access, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  appendThreadMessage,
  getThreadMessages,
  loadContacts,
  saveContacts,
  updateLastThreadMessage
} from "./store.js";

const client = createBirdhouseClient();
const providerKinds = [
  "ai-sdk",
  "openclaw",
  "pi-mono",
  "terminal-cli",
  "claude-code-cli",
  "openclaw-cli",
  "nanoclaw-cli"
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveThreadId(contact: Contact, providedThreadId?: string): string {
  return providedThreadId ?? `${contact.id}-default`;
}

function getContactByIdOrName(contacts: Contact[], reference: string): Contact {
  const contact = contacts.find((item) => item.id === reference || item.displayName.toLowerCase() === reference.toLowerCase());
  if (!contact) {
    throw new Error(`Contact not found: ${reference}`);
  }

  return contact;
}

function parseProviderKind(value: string): ProviderKind {
  if (providerKinds.includes(value as (typeof providerKinds)[number])) {
    return value as ProviderKind;
  }

  throw new Error(`Invalid provider kind: ${value}`);
}

async function readLine(promptText: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

function authFromOptions(options: {
  auth?: string;
  token?: string;
  username?: string;
  password?: string;
}): AuthConfig {
  const authType = options.auth ?? "none";

  if (authType === "bearer") {
    if (!options.token) {
      throw new Error("Bearer auth selected but --token is missing");
    }

    return {
      type: "bearer",
      token: options.token
    };
  }

  if (authType === "basic") {
    if (!options.username || !options.password) {
      throw new Error("Basic auth selected but --username and --password are required");
    }

    return {
      type: "basic",
      username: options.username,
      password: options.password
    };
  }

  return {
    type: "none"
  };
}

async function fileToAttachment(path: string): Promise<Attachment> {
  await access(path);
  const fileStat = await stat(path);
  const fileName = path.split("/").pop() ?? "attachment";

  return {
    id: crypto.randomUUID(),
    kind: fileName.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? "image" : "file",
    name: fileName,
    sizeBytes: fileStat.size,
    uri: path
  };
}

async function sendMessage(contact: Contact, threadId: string, text: string, attachments: Attachment[]): Promise<void> {
  const history = await getThreadMessages(threadId);

  const userMessage: Message = {
    id: crypto.randomUUID(),
    threadId,
    role: "user",
    text,
    attachments,
    status: "sent",
    createdAt: nowIso()
  };

  await appendThreadMessage(threadId, userMessage);

  const agentMessageId = crypto.randomUUID();
  await appendThreadMessage(threadId, {
    id: agentMessageId,
    threadId,
    role: "agent",
    text: "",
    attachments: [],
    status: "streaming",
    createdAt: nowIso()
  });

  let streamedText = "";

  for await (const event of client.chatStream({
    endpoint: {
      baseUrl: contact.provider.baseUrl,
      auth: contact.provider.auth
    },
    request: {
      threadId,
      contact,
      message: {
        id: userMessage.id,
        text,
        attachments
      },
      history,
      metadata: {
        source: "birdhouse-cli"
      }
    }
  })) {
    if (event.type === "token") {
      streamedText += event.text;
      output.write(event.text);
      await updateLastThreadMessage(threadId, (message) => ({
        ...message,
        text: streamedText
      }));
      continue;
    }

    if (event.type === "message_end") {
      await updateLastThreadMessage(threadId, (message) => ({
        ...message,
        text: streamedText || event.text,
        status: "received"
      }));
      output.write("\n");
      continue;
    }

    if (event.type === "error") {
      await updateLastThreadMessage(threadId, (message) => ({
        ...message,
        status: "failed"
      }));
      throw new Error(event.message);
    }
  }
}

program.name("birdhouse").description("Birdhouse CLI client").version("0.1.0");

const contact = program.command("contact").description("Manage contacts");

contact
  .command("add")
  .description("Add a contact")
  .option("--id <id>")
  .option("--name <displayName>")
  .option("--provider <provider>", `Optional override (${providerKinds.join(" | ")})`)
  .option("--endpoint <url>")
  .option("--auth <authType>", "none | bearer | basic", "none")
  .option("--token <token>")
  .option("--username <username>")
  .option("--password <password>")
  .option("--extra <json>", "provider-specific JSON fields")
  .action(async (options) => {
    const displayName = options.name ?? (await readLine("Contact name: "));
    const endpoint = options.endpoint ?? (await readLine("Endpoint URL (Birdhouse server URL): "));
    const authType = options.auth ?? (await readLine("Auth type (none/bearer/basic): "));

    let token = options.token;
    let username = options.username;
    let password = options.password;

    if (authType === "bearer" && !token) {
      token = await readLine("Bearer token: ");
    }

    if (authType === "basic") {
      if (!username) {
        username = await readLine("Basic username: ");
      }
      if (!password) {
        password = await readLine("Basic password: ");
      }
    }

    const auth = authFromOptions({ auth: authType, token, username, password });
    const providerKind = options.provider
      ? parseProviderKind(options.provider)
      : await client.discoverProvider({
          baseUrl: endpoint,
          auth
        });

    if (!options.provider) {
      output.write(`Discovered provider: ${providerKind}\n`);
    }

    const parsedExtra = options.extra ? JSON.parse(options.extra) : {};
    if (
      options.provider &&
      providerKind === "nanoclaw-cli" &&
      (typeof parsedExtra.command !== "string" || parsedExtra.command.trim().length === 0)
    ) {
      parsedExtra.command = await readLine("NanoClaw command to execute (e.g. node /path/to/nanoclaw-entry.js): ");
    }

    const contactToSave: Contact = {
      id: options.id ?? crypto.randomUUID(),
      displayName,
      provider: {
        kind: providerKind,
        baseUrl: endpoint,
        auth,
        extra: parsedExtra
      }
    };

    const contacts = await loadContacts();
    contacts.push(contactToSave);
    await saveContacts(contacts);

    output.write(`Saved contact ${contactToSave.displayName} (${contactToSave.id})\n`);
  });

contact
  .command("list")
  .description("List contacts")
  .action(async () => {
    const contacts = await loadContacts();
    if (!contacts.length) {
      output.write("No contacts found.\n");
      return;
    }

    for (const item of contacts) {
      output.write(`${item.id} | ${item.displayName} | ${item.provider.kind} | ${item.provider.baseUrl}\n`);
    }
  });

program
  .command("login")
  .description("Update auth credentials for a contact")
  .requiredOption("--contact <idOrName>")
  .requiredOption("--auth <authType>", "none | bearer | basic")
  .option("--token <token>")
  .option("--username <username>")
  .option("--password <password>")
  .action(async (options) => {
    const contacts = await loadContacts();
    const target = getContactByIdOrName(contacts, options.contact);

    target.provider.auth = authFromOptions({
      auth: options.auth,
      token: options.token,
      username: options.username,
      password: options.password
    });

    await saveContacts(contacts);
    output.write(`Updated auth for ${target.displayName}.\n`);
  });

program
  .command("send")
  .description("Send a single message")
  .requiredOption("--contact <idOrName>")
  .requiredOption("--text <text>")
  .option("--thread <threadId>")
  .option("--attach <path...>", "Attachment paths")
  .action(async (options) => {
    const contacts = await loadContacts();
    const contact = getContactByIdOrName(contacts, options.contact);
    const threadId = resolveThreadId(contact, options.thread);

    const attachments: Attachment[] = [];
    for (const path of options.attach ?? []) {
      attachments.push(await fileToAttachment(path));
    }

    await sendMessage(contact, threadId, options.text, attachments);
  });

program
  .command("chat")
  .description("Open interactive chat")
  .requiredOption("--contact <idOrName>")
  .option("--thread <threadId>")
  .action(async (options) => {
    const contacts = await loadContacts();
    const contact = getContactByIdOrName(contacts, options.contact);
    const threadId = resolveThreadId(contact, options.thread);

    output.write(`Chatting with ${contact.displayName}. Type /exit to quit.\n`);

    const rl = createInterface({ input, output });

    try {
      while (true) {
        const line = (await rl.question("you> ")).trim();

        if (!line) {
          continue;
        }

        if (line === "/exit") {
          break;
        }

        if (line.startsWith("/trigger")) {
          const text = line.replace(/^\/trigger\s*/, "").trim();
          await client.triggerAsync({
            endpoint: {
              baseUrl: contact.provider.baseUrl,
              auth: contact.provider.auth
            },
            request: {
              contact,
              threadId,
              text: text || undefined
            }
          });
          output.write("Triggered async follow-up.\n");
          continue;
        }

        output.write(`${contact.displayName}> `);
        await sendMessage(contact, threadId, line, []);
      }
    } finally {
      rl.close();
    }
  });

program
  .command("trigger")
  .description("Trigger an async follow-up message")
  .requiredOption("--contact <idOrName>")
  .option("--thread <threadId>")
  .option("--text <text>")
  .action(async (options) => {
    const contacts = await loadContacts();
    const contact = getContactByIdOrName(contacts, options.contact);
    const threadId = resolveThreadId(contact, options.thread);

    await client.triggerAsync({
      endpoint: {
        baseUrl: contact.provider.baseUrl,
        auth: contact.provider.auth
      },
      request: {
        contact,
        threadId,
        text: options.text
      }
    });

    output.write("Async trigger queued.\n");
  });

program
  .command("schedule")
  .description("Schedule an async follow-up message")
  .requiredOption("--contact <idOrName>")
  .requiredOption("--delay <seconds>")
  .option("--thread <threadId>")
  .option("--text <text>")
  .action(async (options) => {
    const contacts = await loadContacts();
    const contact = getContactByIdOrName(contacts, options.contact);
    const threadId = resolveThreadId(contact, options.thread);

    await client.scheduleAsync({
      endpoint: {
        baseUrl: contact.provider.baseUrl,
        auth: contact.provider.auth
      },
      request: {
        contact,
        threadId,
        delaySeconds: Number(options.delay),
        text: options.text
      }
    });

    output.write(`Scheduled async message in ${options.delay} seconds.\n`);
  });

program
  .command("capabilities")
  .description("Inspect provider capabilities from a Birdhouse server")
  .requiredOption("--endpoint <url>")
  .option("--auth <authType>", "none | bearer | basic", "none")
  .option("--token <token>")
  .option("--username <username>")
  .option("--password <password>")
  .action(async (options) => {
    const auth = authFromOptions({
      auth: options.auth,
      token: options.token,
      username: options.username,
      password: options.password
    });

    const capabilities = await client.listCapabilities({
      baseUrl: options.endpoint,
      auth
    });

    if (!capabilities.length) {
      output.write("No capabilities reported.\n");
      return;
    }

    for (const capability of capabilities) {
      output.write(
        `${capability.kind}: stream=${capability.supportsStreaming} attachments=${capability.supportsAttachments} async=${capability.supportsAsync}\n`
      );
    }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  output.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
