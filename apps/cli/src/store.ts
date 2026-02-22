import type { Contact, Message } from "@birdhouse/protocol";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = join(homedir(), ".birdhouse");
const contactsPath = join(dataDir, "contacts.json");
const threadsPath = join(dataDir, "threads.json");

type ThreadStore = Record<string, Message[]>;

async function ensureDataDir(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const contents = await readFile(path, "utf-8");
    return JSON.parse(contents) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await ensureDataDir();
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
}

export async function loadContacts(): Promise<Contact[]> {
  return readJsonFile<Contact[]>(contactsPath, []);
}

export async function saveContacts(contacts: Contact[]): Promise<void> {
  await writeJsonFile(contactsPath, contacts);
}

export async function loadThreads(): Promise<ThreadStore> {
  return readJsonFile<ThreadStore>(threadsPath, {});
}

export async function saveThreads(threads: ThreadStore): Promise<void> {
  await writeJsonFile(threadsPath, threads);
}

export async function appendThreadMessage(threadId: string, message: Message): Promise<void> {
  const threads = await loadThreads();
  threads[threadId] = [...(threads[threadId] ?? []), message];
  await saveThreads(threads);
}

export async function updateLastThreadMessage(threadId: string, update: (message: Message) => Message): Promise<void> {
  const threads = await loadThreads();
  const thread = threads[threadId] ?? [];
  if (!thread.length) {
    return;
  }

  const updatedThread = [...thread];
  updatedThread[updatedThread.length - 1] = update(updatedThread[updatedThread.length - 1]);
  threads[threadId] = updatedThread;
  await saveThreads(threads);
}

export async function getThreadMessages(threadId: string): Promise<Message[]> {
  const threads = await loadThreads();
  return threads[threadId] ?? [];
}
