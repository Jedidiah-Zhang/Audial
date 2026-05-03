import AsyncStorage from "@react-native-async-storage/async-storage";

const SAVED_ACCOUNTS_KEY = "ll:savedAccounts";
const MAX_SAVED = 5;

export type SavedAccountKind = "clerk" | "local";
export type SavedAccountMethod = "password" | "google" | "microsoft" | "local";

export interface SavedAccount {
  id: string;
  kind: SavedAccountKind;
  displayName: string;
  email?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  lastMethod: SavedAccountMethod;
  lastUsedAt: number;
}

function safeParse(raw: string | null): SavedAccount[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is SavedAccount =>
        !!e && typeof e.id === "string" && (e.kind === "clerk" || e.kind === "local"),
    );
  } catch {
    return [];
  }
}

export async function listSavedAccounts(): Promise<SavedAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(SAVED_ACCOUNTS_KEY);
    const list = safeParse(raw);
    return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  } catch {
    return [];
  }
}

async function writeAll(next: SavedAccount[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export async function upsertSavedAccount(
  partial: Omit<SavedAccount, "lastUsedAt"> & { lastUsedAt?: number },
): Promise<SavedAccount[]> {
  const now = partial.lastUsedAt ?? Date.now();
  const current = await listSavedAccounts();
  const matchKey = (a: SavedAccount) => a.kind === partial.kind && a.id === partial.id;
  const filtered = current.filter((a) => !matchKey(a));
  const next: SavedAccount = {
    id: partial.id,
    kind: partial.kind,
    displayName: partial.displayName,
    email: partial.email ?? null,
    username: partial.username ?? null,
    imageUrl: partial.imageUrl ?? null,
    lastMethod: partial.lastMethod,
    lastUsedAt: now,
  };
  const merged = [next, ...filtered]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_SAVED);
  await writeAll(merged);
  return merged;
}

export async function removeSavedAccount(
  kind: SavedAccountKind,
  id: string,
): Promise<SavedAccount[]> {
  const current = await listSavedAccounts();
  const next = current.filter((a) => !(a.kind === kind && a.id === id));
  await writeAll(next);
  return next;
}

// ── Pending sign-in method ────────────────────────────────────────────
//
// The auth screens know which method (password / google / microsoft) the
// user just initiated, but the actual upsert happens in a Clerk-aware
// listener that watches `useUser()` for the post-authentication user
// snapshot. This module-level slot bridges the two — the auth screen
// sets it before kicking off the flow, and the listener reads + clears
// it when it sees a fresh sign-in.

let pendingMethod: SavedAccountMethod | null = null;

export function setPendingSignInMethod(method: SavedAccountMethod | null): void {
  pendingMethod = method;
}

export function consumePendingSignInMethod(): SavedAccountMethod | null {
  const m = pendingMethod;
  pendingMethod = null;
  return m;
}

// ── Cross-component change notification ───────────────────────────────
//
// AsyncStorage doesn't notify React subscribers when a key changes, so
// we maintain a tiny in-process pub/sub. Anything that mutates the saved
// accounts list calls `notifySavedAccountsChanged()`; the
// `useSavedAccounts` hook subscribes and re-reads on each tick.

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeSavedAccounts(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifySavedAccountsChanged(): void {
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch {
      // ignore
    }
  }
}
