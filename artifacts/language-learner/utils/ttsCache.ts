import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const SUBDIR = "tts-cache";
const INDEX_PREFIX = "tts-index:";

let _fsModulePromise: Promise<any> | null = null;
async function getFs(): Promise<any | null> {
  if (Platform.OS === "web") return null;
  if (!_fsModulePromise) {
    _fsModulePromise = import("expo-file-system").catch(() => null);
  }
  return _fsModulePromise;
}

async function ensureDir(): Promise<void> {
  const FS = await getFs();
  if (!FS?.Directory || !FS?.Paths) return;
  try {
    const dir = new FS.Directory(FS.Paths.document, SUBDIR);
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
  try {
    const FS = await getFs();
    if (!FS?.File || !FS?.Paths) return null;
    const name = await fileNameFor(text, voice);
    const file = new FS.File(FS.Paths.document, SUBDIR, name);
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
  try {
    const FS = await getFs();
    if (!FS?.File || !FS?.Paths) return null;
    await ensureDir();
    const name = await fileNameFor(text, voice);
    const file = new FS.File(FS.Paths.document, SUBDIR, name);
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
  try {
    const name = await fileNameFor(text, voice);
    const idx = await readIndex(userId);
    const list = idx[articleId] ?? [];
    if (!list.includes(name)) {
      idx[articleId] = [...list, name];
      await writeIndex(userId, idx);
    }
  } catch {
    // ignore
  }
}

/**
 * Delete every cached audio file associated with an article and remove its
 * index entry. No-op on web (web has no persistent file cache).
 */
export async function clearArticleAudio(
  userId: string | null | undefined,
  articleId: string | null | undefined
): Promise<void> {
  if (!userId || !articleId) return;
  try {
    const idx = await readIndex(userId);
    const files = idx[articleId] ?? [];
    if (files.length > 0) {
      const FS = await getFs();
      if (FS?.File && FS?.Paths) {
        for (const name of files) {
          try {
            const f = new FS.File(FS.Paths.document, SUBDIR, name);
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
  } catch {
    // ignore
  }
}
