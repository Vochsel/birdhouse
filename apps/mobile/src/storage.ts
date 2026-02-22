import type { Contact, Message } from "@birdhouse/protocol";
import AsyncStorage from "@react-native-async-storage/async-storage";

const CONTACTS_KEY = "birdhouse.contacts";
const THREADS_KEY = "birdhouse.threads";

export type ThreadStore = Record<string, Message[]>;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await AsyncStorage.getItem(key);
    if (!value) {
      return fallback;
    }

    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function loadContacts(): Promise<Contact[]> {
  return readJson<Contact[]>(CONTACTS_KEY, []);
}

export async function saveContacts(contacts: Contact[]): Promise<void> {
  await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
}

export async function loadThreads(): Promise<ThreadStore> {
  return readJson<ThreadStore>(THREADS_KEY, {});
}

export async function saveThreads(threads: ThreadStore): Promise<void> {
  await AsyncStorage.setItem(THREADS_KEY, JSON.stringify(threads));
}
