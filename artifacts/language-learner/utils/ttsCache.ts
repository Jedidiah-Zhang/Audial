import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";

const SUBDIR = "tts-cache";
const INDEX_PREFIX = "tts-index:";

function ensureDir(): void {
  if (Platform.OS === "web") return;
  try {
    const dir = new Directory(Paths.document, SUBDIR);
    if (!dir.exists) {
      try {
        dir.create();
      } catch {
        // ignore (race / already exists)
      }
    }
  } catch {
    // ignore
  }
}

async function fileNameFor(text: string, voice: string): Promise<string> {
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA1,
    `${voice}::${text}`
  );
  return `${voice}-${hash}.mp3`;
}

export async function getCachedTTSUri(
  text: string,
  voice: string
): Promise<string | null> {
  if (Platform.OS === "web") return null;
  try {
    const name = await fileNameFor(text, voice);
    const file = new File(Paths.document, SUBDIR, name);
    if (file.exists) return file.uri;
    return null;
  } catch {
    return null;
  }
}

export async function writeCachedTTS(
  text: string,
  voice: string,
  buffer: ArrayBuffer
): Promise<{ uri: string; fileName: string } | null> {
  if (Platform.OS === "web") return null;
  try {
    ensureDir();
    const name = await fileNameFor(text, voice);
    const file = new File(Paths.document, SUBDIR, name);
    if (!file.exists) {
      file.create();
      file.write(new Uint8Array(buffer));
    }
    return { uri: file.uri, fileName: name };
  } catch {
    return null;
  }
}

function indexKey(userId: string) {
  return `${INDEX_PREFIX}${userId}`;
}

async function readIndex(
  userId: string
): Promise<Record<string, string[]>> {
  try {
    const raw = await AsyncStorage.getItem(indexKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string[]>;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeIndex(
  userId: string,
  idx: Record<string, string[]>
): Promise<void> {
  try {
    await AsyncStorage.setItem(indexKey(userId), JSON.stringify(idx));
  } catch {
    // ignore
  }
}

// Per-user serialization for read-modify-write on the index. Without this,
// concurrent prefetch/play calls (and concurrent remove) can lose updates.
const _indexQueues = new Map<string, Promise<unknown>>();
function withIndexLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _indexQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  _indexQueues.set(
    userId,
    next.catch(() => undefined)
  );
  return next;
}

// Articles that have been removed but may still have in-flight prefetch/play
// calls trying to register against them. Per-user set of article ids.
const _tombstones = new Map<string, Set<string>>();
function isTombstoned(userId: string, articleId: string): boolean {
  return _tombstones.get(userId)?.has(articleId) ?? false;
}
function addTombstone(userId: string, articleId: string) {
  let set = _tombstones.get(userId);
  if (!set) {
    set = new Set();
    _tombstones.set(userId, set);
  }
  set.add(articleId);
}

/**
 * Register that a given (text, voice) audio file belongs to an article so it
 * can be cleaned up when the article is removed. Safe to call repeatedly; the
 * same file is only recorded once per article.
 */
export async function registerArticleAudio(
  userId: string | null | undefined,
  articleId: string | null | undefined,
  text: string,
  voice: string
): Promise<void> {
  if (!userId || !articleId) return;
  if (Platform.OS === "web") return;
  if (isTombstoned(userId, articleId)) return;
  try {
    const name = await fileNameFor(text, voice);
    await withIndexLock(userId, async () => {
      // Re-check inside the lock in case removal happened while we hashed.
      if (isTombstoned(userId, articleId)) return;
      const idx = await readIndex(userId);
      const list = idx[articleId] ?? [];
      if (!list.includes(name)) {
        idx[articleId] = [...list, name];
        await writeIndex(userId, idx);
      }
    });
  } catch {
    // ignore
  }
}

/**
 * Move all audio index entries from one user to another. Used by the guest →
 * signed-in migration: audio files on disk are content-addressed by
 * (voice, text) hash, so transferring ownership is just re-keying the index.
 *
 * Merge policy on articleId collision: the target user wins (their existing
 * entry is kept). After a successful merge the source index is removed.
 */
export async function transferAudioOwnership(
  fromUserId: string,
  toUserId: string
): Promise<void> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return;
  // Lock both queues. Acquire `from` first then `to` to keep a consistent
  // ordering across all callers (only this function touches two scopes).
  await withIndexLock(fromUserId, async () => {
    await withIndexLock(toUserId, async () => {
      const fromIdx = await readIndex(fromUserId);
      if (Object.keys(fromIdx).length === 0) return;
      const toIdx = await readIndex(toUserId);
      let mutated = false;
      for (const [articleId, files] of Object.entries(fromIdx)) {
        if (toIdx[articleId]) continue; // target wins
        if (Array.isArray(files) && files.length > 0) {
          toIdx[articleId] = [...files];
          mutated = true;
        }
      }
      if (mutated) await writeIndex(toUserId, toIdx);
      try {
        await AsyncStorage.removeItem(indexKey(fromUserId));
      } catch {
        // ignore
      }
    });
  });
}

/**
 * Delete every cached audio file associated with an article and remove its
 * index entry. Files referenced by other articles are kept. No-op on web
 * (web has no persistent file cache).
 */
export async function clearArticleAudio(
  userId: string | null | undefined,
  articleId: string | null | undefined
): Promise<void> {
  if (!userId || !articleId) return;
  // Mark tombstone synchronously so any in-flight register is suppressed even
  // before the lock is acquired.
  addTombstone(userId, articleId);
  try {
    await withIndexLock(userId, async () => {
      const idx = await readIndex(userId);
      const files = idx[articleId] ?? [];
      if (files.length > 0) {
        // Build a set of filenames still referenced by *other* articles so we
        // don't delete shared files.
        const referencedElsewhere = new Set<string>();
        for (const [otherId, list] of Object.entries(idx)) {
          if (otherId === articleId) continue;
          for (const n of list) referencedElsewhere.add(n);
        }
        if (Platform.OS !== "web") {
          for (const name of files) {
            if (referencedElsewhere.has(name)) continue;
            try {
              const f = new File(Paths.document, SUBDIR, name);
              if (f.exists) f.delete();
            } catch {
              // ignore individual failures
            }
          }
        }
      }
      if (articleId in idx) {
        delete idx[articleId];
        await writeIndex(userId, idx);
      }
    });
  } catch {
    // ignore
  }
}
