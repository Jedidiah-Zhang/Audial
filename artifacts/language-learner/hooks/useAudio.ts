import { useState, useRef, useCallback, useEffect } from "react";
import { AppState, Linking, Platform } from "react-native";
import {
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  useAudioRecorder as useExpoAudioRecorder,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import {
  getCachedTTSUri,
  writeCachedTTS,
  registerArticleAudio,
} from "@/utils/ttsCache";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

const audioCache = new Map<string, ArrayBuffer>();
const inflight = new Map<string, Promise<ArrayBuffer>>();

function cacheKey(text: string, voice: string) {
  return `${voice}::${text}`;
}

async function fetchTTS(text: string, voice: string): Promise<ArrayBuffer> {
  const key = cacheKey(text, voice);
  const cached = audioCache.get(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const response = await fetch(`${BASE_URL}/api/language/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!response.ok) throw new Error("TTS request failed");
    const buf = await response.arrayBuffer();
    audioCache.set(key, buf);
    return buf;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

export async function prefetchTTS(
  text: string,
  voice: string,
  opts?: { userId?: string | null; articleId?: string | null }
): Promise<void> {
  try {
    if (Platform.OS !== "web") {
      const cached = await getCachedTTSUri(text, voice);
      if (cached) {
        if (opts?.userId && opts?.articleId) {
          registerArticleAudio(opts.userId, opts.articleId, text, voice);
        }
        return;
      }
      const buffer = await fetchTTS(text, voice);
      const written = await writeCachedTTS(text, voice, buffer);
      if (written && opts?.userId && opts?.articleId) {
        registerArticleAudio(opts.userId, opts.articleId, text, voice);
      }
      return;
    }
    await fetchTTS(text, voice);
  } catch {
    /* silent prefetch failure */
  }
}

function _arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    );
  }
  return btoa(binary);
}

export function useAudioPlayer(opts?: {
  articleId?: string | null;
  userId?: string | null;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const expoPlayerRef = useRef<any>(null);
  const expoSubRef = useRef<any>(null);
  const currentRateRef = useRef<number>(1);
  const articleIdRef = useRef<string | null | undefined>(opts?.articleId);
  const userIdRef = useRef<string | null | undefined>(opts?.userId);
  articleIdRef.current = opts?.articleId;
  userIdRef.current = opts?.userId;

  const cleanupCurrent = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {}
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      try {
        URL.revokeObjectURL(audioUrlRef.current);
      } catch {}
      audioUrlRef.current = null;
    }
    if (expoSubRef.current) {
      try {
        expoSubRef.current.remove?.();
      } catch {}
      expoSubRef.current = null;
    }
    if (expoPlayerRef.current) {
      try {
        expoPlayerRef.current.pause?.();
        expoPlayerRef.current.remove?.();
      } catch {}
      expoPlayerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupCurrent();
    };
  }, [cleanupCurrent]);

  const playTTS = useCallback(
    async (
      text: string,
      voice = "nova",
      onEnded?: () => void,
      rate?: number
    ) => {
      try {
        cleanupCurrent();
        setIsPlaying(false);

        const playbackRate = rate ?? currentRateRef.current;
        currentRateRef.current = playbackRate;

        if (Platform.OS === "web") {
          const key = cacheKey(text, voice);
          const wasCached = audioCache.has(key);
          if (!wasCached) setIsLoading(true);
          const buffer = await fetchTTS(text, voice);
          const blob = new Blob([buffer], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          const audio = new Audio();
          audio.preload = "auto";
          (audio as any).preservesPitch = true;
          (audio as any).mozPreservesPitch = true;
          (audio as any).webkitPreservesPitch = true;
          audioRef.current = audio;
          audioUrlRef.current = url;

          audio.onended = () => {
            setIsPlaying(false);
            if (audioUrlRef.current === url) {
              try {
                URL.revokeObjectURL(url);
              } catch {}
              audioUrlRef.current = null;
              audioRef.current = null;
            }
            onEnded?.();
          };
          audio.onerror = () => {
            setIsPlaying(false);
            if (audioUrlRef.current === url) {
              try {
                URL.revokeObjectURL(url);
              } catch {}
              audioUrlRef.current = null;
              audioRef.current = null;
            }
          };

          // Wait until the browser has buffered enough to play through without stalling.
          // Without this, fresh blob URLs can play partial audio and end prematurely.
          await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const onReady = () => done();
            audio.addEventListener("canplaythrough", onReady, { once: true });
            audio.addEventListener("loadeddata", () => {
              // Fallback: some browsers don't fire canplaythrough for blob URLs.
              // After loadeddata, give a tiny window for canplaythrough then proceed.
              setTimeout(done, 150);
            }, { once: true });
            audio.addEventListener("error", done, { once: true });
            // Hard cap so we never hang
            setTimeout(done, 2000);
            audio.src = url;
            audio.load();
          });

          // Apply playback rate after metadata is available
          audio.playbackRate = playbackRate;
          setIsLoading(false);
          if (audioRef.current !== audio) {
            // Was replaced/cleaned up while waiting; abort and free the orphaned URL
            try {
              URL.revokeObjectURL(url);
            } catch {}
            return;
          }
          setIsPlaying(true);
          try {
            await audio.play();
          } catch {
            setIsPlaying(false);
          }
        } else {
          let uri: string | null = await getCachedTTSUri(text, voice);
          if (uri) {
            if (userIdRef.current && articleIdRef.current) {
              registerArticleAudio(
                userIdRef.current,
                articleIdRef.current,
                text,
                voice
              );
            }
          } else {
            const memKey = cacheKey(text, voice);
            const wasMem = audioCache.has(memKey);
            if (!wasMem) setIsLoading(true);
            const buffer = await fetchTTS(text, voice);
            const written = await writeCachedTTS(text, voice, buffer);
            if (written) {
              uri = written.uri;
              if (userIdRef.current && articleIdRef.current) {
                registerArticleAudio(
                  userIdRef.current,
                  articleIdRef.current,
                  text,
                  voice
                );
              }
            } else {
              // Last-resort fallback: ephemeral cache file or data URI so
              // playback still works when the persistent write failed.
              try {
                const file = new File(
                  Paths.cache,
                  `tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`
                );
                try { file.delete(); } catch {}
                file.create();
                file.write(new Uint8Array(buffer));
                uri = file.uri;
              } catch {
                const base64 = _arrayBufferToBase64(buffer);
                uri = `data:audio/mpeg;base64,${base64}`;
              }
            }
          }
          const player = createAudioPlayer({ uri: uri! });
          expoPlayerRef.current = player;
          try {
            if (typeof player.setPlaybackRate === "function") {
              player.setPlaybackRate(playbackRate, "high");
            } else {
              player.playbackRate = playbackRate;
            }
            player.shouldCorrectPitch = true;
          } catch {}
          setIsLoading(false);
          setIsPlaying(true);
          let didEnd = false;
          // Only react to didJustFinish. `status.isLoaded` momentarily flips
          // false during buffer transitions and would cause a UI flicker
          // ("paused" mid-playback) if we toggled isPlaying off on it.
          const sub = player.addListener("playbackStatusUpdate", (status: any) => {
            if (status.didJustFinish && !didEnd) {
              didEnd = true;
              setIsPlaying(false);
              try { sub?.remove?.(); } catch {}
              if (expoSubRef.current === sub) expoSubRef.current = null;
              onEnded?.();
            }
          });
          expoSubRef.current = sub;
          player.play();
        }
      } catch {
        setIsPlaying(false);
        setIsLoading(false);
      }
    },
    [cleanupCurrent]
  );

  const stop = useCallback(() => {
    cleanupCurrent();
    setIsPlaying(false);
  }, [cleanupCurrent]);

  const setRate = useCallback((rate: number) => {
    currentRateRef.current = rate;
    if (audioRef.current) {
      try {
        audioRef.current.playbackRate = rate;
      } catch {}
    }
    if (expoPlayerRef.current) {
      try {
        if (typeof expoPlayerRef.current.setPlaybackRate === "function") {
          expoPlayerRef.current.setPlaybackRate(rate, "high");
        } else {
          expoPlayerRef.current.playbackRate = rate;
        }
      } catch {}
    }
  }, []);

  return { playTTS, stop, isPlaying, isLoading, setRate };
}

// Granular mic-permission state shared by both platforms.
//   - "unknown"  : we haven't been able to determine status yet (initial mount,
//                  or a Permissions API that doesn't expose mic on this browser)
//   - "granted"  : ready to record
//   - "denied"   : the user said no, but we can ask the system again
//                  (iOS / Android first denial, or web "prompt" leftover)
//   - "blocked"  : the OS / browser will no longer prompt; the user has to
//                  flip a toggle in Settings (native) or the address-bar lock
//                  icon (web). The UI surfaces an "Open Settings" path for
//                  this case.
export type MicPermission = "unknown" | "granted" | "denied" | "blocked";

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [permission, setPermission] = useState<MicPermission>("unknown");
  const recorder = useExpoAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const webMediaRef = useRef<MediaRecorder | null>(null);
  const webChunksRef = useRef<Blob[]>([]);

  // Read the current permission status WITHOUT triggering a system prompt.
  // The previous version called `requestRecordingPermissionsAsync` on mount,
  // which silently popped the iOS / Android permission dialog the moment the
  // session screen mounted — disorienting for users who hadn't yet tapped
  // the mic. We now sniff the existing status only and defer the actual
  // prompt to the first user-initiated mic tap (see `requestPermission`).
  //
  // This same sniff is also used to re-sync after the app returns to the
  // foreground — critical for the "blocked → Open Settings → toggle on →
  // come back" flow. Without that resync the UI would stay stuck in the
  // blocked variant even after the user enabled the mic in Settings.
  const syncPermission = useCallback(async (): Promise<MicPermission> => {
    if (Platform.OS === "web") {
      // The Permissions API isn't universally supported (e.g. some Safari
      // versions, older Firefox) but where it is, we can distinguish
      // already-granted, will-prompt, and persistently-denied without
      // touching the user's mic.
      try {
        const perms = (navigator as unknown as { permissions?: { query?: (q: { name: string }) => Promise<{ state: string; onchange?: (() => void) | null }> } }).permissions;
        if (perms?.query) {
          const status = await perms.query({ name: "microphone" });
          const next: MicPermission =
            status.state === "granted"
              ? "granted"
              : status.state === "denied"
              ? "blocked"
              : "unknown";
          setPermission(next);
          return next;
        }
      } catch {
        /* fall through to "unknown" */
      }
      setPermission("unknown");
      return "unknown";
    }
    try {
      const { granted, canAskAgain } =
        await AudioModule.getRecordingPermissionsAsync();
      const next: MicPermission = granted
        ? "granted"
        : canAskAgain
        ? "denied"
        : "blocked";
      setPermission(next);
      return next;
    } catch {
      setPermission("unknown");
      return "unknown";
    }
  }, []);

  // Initial mount sniff + wire up the live web Permissions API onchange.
  useEffect(() => {
    let cancelled = false;
    let permStatus:
      | { onchange?: (() => void) | null }
      | null = null;
    (async () => {
      if (Platform.OS === "web") {
        try {
          const perms = (navigator as unknown as { permissions?: { query?: (q: { name: string }) => Promise<{ state: string; onchange?: (() => void) | null }> } }).permissions;
          if (perms?.query) {
            const status = await perms.query({ name: "microphone" });
            if (cancelled) return;
            const apply = (s: string) => {
              if (s === "granted") setPermission("granted");
              else if (s === "denied") setPermission("blocked");
              else setPermission("unknown");
            };
            apply(status.state);
            // Live-update if the user changes the setting in the browser
            // while the page is open (covers the address-bar lock-icon
            // toggle without needing a tab refresh).
            status.onchange = () => apply(status.state);
            permStatus = status;
            return;
          }
        } catch {
          /* fall through */
        }
        if (!cancelled) await syncPermission();
        return;
      }
      if (!cancelled) await syncPermission();
    })();
    return () => {
      cancelled = true;
      if (permStatus) permStatus.onchange = null;
    };
  }, [syncPermission]);

  // Re-sync whenever the app comes back to the foreground. This is the
  // critical piece for the blocked → Settings → return → record flow:
  // - Native: AppState flips to "active" when the user navigates back from
  //   the system Settings app. We re-read the permission so the UI exits
  //   the blocked variant on the next mic tap.
  // - Web: `visibilitychange` fires when the user re-focuses the tab after
  //   toggling site permissions in the address-bar lock menu. (The
  //   Permissions API onchange handler above usually catches this too,
  //   but visibilitychange is the universal fallback for browsers without
  //   reliable onchange dispatch.)
  useEffect(() => {
    if (Platform.OS === "web") {
      const onVis = () => {
        if (typeof document !== "undefined" && !document.hidden) {
          void syncPermission();
        }
      };
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVis);
        return () => {
          document.removeEventListener("visibilitychange", onVis);
        };
      }
      return;
    }
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncPermission();
    });
    return () => {
      sub.remove();
    };
  }, [syncPermission]);

  // Actively request the mic. Triggers the system / browser prompt the first
  // time, and reports back the resulting state so callers can decide whether
  // to immediately start recording or surface the "blocked" UI variant.
  const requestPermission = useCallback(async (): Promise<MicPermission> => {
    if (Platform.OS === "web") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // We only needed to trigger the prompt — release the device right
        // away so the actual `startRecording` call gets a fresh stream.
        stream.getTracks().forEach((t) => t.stop());
        setPermission("granted");
        return "granted";
      } catch (e) {
        // NotAllowedError can mean either "user just clicked Block" or
        // "browser remembered a prior block". Either way the only path back
        // is via the browser's site settings, so treat it as `blocked` and
        // let the UI show the address-bar hint variant.
        const name = (e as { name?: string } | null)?.name;
        if (name === "NotAllowedError" || name === "SecurityError") {
          setPermission("blocked");
          return "blocked";
        }
        setPermission("denied");
        return "denied";
      }
    }
    try {
      const { granted, canAskAgain } =
        await AudioModule.requestRecordingPermissionsAsync();
      const next: MicPermission = granted
        ? "granted"
        : canAskAgain
        ? "denied"
        : "blocked";
      setPermission(next);
      return next;
    } catch {
      setPermission("denied");
      return "denied";
    }
  }, []);

  // Native: jump straight to this app's entry in the OS settings so the user
  // can flip the mic toggle. Web: no-op — the UI shows a textual hint about
  // the address-bar lock icon since browsers don't expose a deep-link API.
  const openAppSettings = useCallback(() => {
    if (Platform.OS === "web") return;
    try {
      Linking.openSettings();
    } catch {
      /* swallow — best-effort jump */
    }
  }, []);

  const startRecording = useCallback(async (): Promise<boolean> => {
    // Defensive: callers are expected to gate on `permission === "granted"`
    // first (see `useMicPermissionGate`), but if we somehow get here without
    // permission, do an opportunistic re-check that does NOT trigger a system
    // prompt — falling back to `false` so the caller's gate logic can take
    // over.
    if (permission !== "granted") {
      if (Platform.OS === "web") {
        // On web `getUserMedia` itself acts as the prompt; if it succeeds we
        // can proceed, otherwise we bail and let the gate handle it.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          setPermission("granted");
        } catch {
          return false;
        }
      } else {
        try {
          const { granted } = await AudioModule.getRecordingPermissionsAsync();
          if (granted) setPermission("granted");
          else return false;
        } catch {
          return false;
        }
      }
    }

    try {
      if (Platform.OS === "web") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";
        const mediaRecorder = new MediaRecorder(stream, { mimeType });
        webChunksRef.current = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) webChunksRef.current.push(e.data);
        };
        mediaRecorder.start(100);
        webMediaRef.current = mediaRecorder;
        setIsRecording(true);
        return true;
      } else {
        await recorder.record();
        setIsRecording(true);
        return true;
      }
    } catch {
      setIsRecording(false);
      return false;
    }
  }, [permission, recorder]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    if (!isRecording) return null;
    setIsRecording(false);

    try {
      if (Platform.OS === "web") {
        const mediaRecorder = webMediaRef.current;
        if (!mediaRecorder) return null;

        return new Promise<Blob | null>((resolve) => {
          mediaRecorder.onstop = () => {
            const blob = new Blob(webChunksRef.current, { type: mediaRecorder.mimeType });
            mediaRecorder.stream.getTracks().forEach((t) => t.stop());
            webMediaRef.current = null;
            resolve(blob);
          };
          mediaRecorder.stop();
        });
      } else {
        await recorder.stop();
        const uri = recorder.uri;
        if (!uri) return null;

        const file = new File(uri);
        const byteArray = await file.bytes();
        return new Blob([byteArray], { type: "audio/wav" });
      }
    } catch {
      return null;
    }
  }, [isRecording, recorder]);

  return {
    startRecording,
    stopRecording,
    isRecording,
    permission,
    requestPermission,
    openAppSettings,
    syncPermission,
  };
}

export async function transcribeAudio(
  audioBlob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  const response = await fetch(`${BASE_URL}/api/language/stt`, {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: arrayBuffer,
    signal,
  });

  if (!response.ok) throw new Error("Transcription failed");
  const data = await response.json() as { success: boolean; transcript: string };
  return data.transcript;
}
