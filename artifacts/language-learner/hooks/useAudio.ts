import { useState, useRef, useCallback, useEffect } from "react";
import { Platform } from "react-native";
import { AudioModule, RecordingPresets, useAudioRecorder as useExpoAudioRecorder } from "expo-audio";

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

export async function prefetchTTS(text: string, voice: string): Promise<void> {
  try {
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

// Module-level Web Audio context shared across plays (browser limit: ~6 contexts)
let _audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as
    | typeof AudioContext
    | undefined;
  if (!Ctx) return null;
  if (!_audioCtx || _audioCtx.state === "closed") {
    _audioCtx = new Ctx();
  }
  return _audioCtx;
}

// Cache decoded AudioBuffers per (voice, text) so we only decode once
const decodedCache = new Map<string, AudioBuffer>();

export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const expoPlayerRef = useRef<any>(null);
  const currentRateRef = useRef<number>(1);
  const playTokenRef = useRef(0);

  const cleanupCurrent = useCallback(() => {
    playTokenRef.current++;
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null;
        sourceRef.current.stop();
      } catch {}
      try {
        sourceRef.current.disconnect();
      } catch {}
      sourceRef.current = null;
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

        const key = cacheKey(text, voice);
        const wasCached = audioCache.has(key);
        if (!wasCached) setIsLoading(true);

        const buffer = await fetchTTS(text, voice);
        const playbackRate = rate ?? currentRateRef.current;
        currentRateRef.current = playbackRate;

        if (Platform.OS === "web") {
          const ctx = getAudioContext();
          if (!ctx) {
            setIsLoading(false);
            return;
          }
          // Resume context (required after user gesture if suspended)
          if (ctx.state === "suspended") {
            try {
              await ctx.resume();
            } catch {}
          }

          // Decode (cached) — copy buffer because decodeAudioData consumes it
          let audioBuffer = decodedCache.get(key);
          if (!audioBuffer) {
            const copy = buffer.slice(0);
            audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
              ctx.decodeAudioData(copy, resolve, reject);
            });
            decodedCache.set(key, audioBuffer);
          }

          const token = ++playTokenRef.current;
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          try {
            source.playbackRate.value = playbackRate;
          } catch {}
          source.connect(ctx.destination);

          sourceRef.current = source;
          setIsLoading(false);
          setIsPlaying(true);

          source.onended = () => {
            if (playTokenRef.current !== token) return;
            setIsPlaying(false);
            if (sourceRef.current === source) {
              try {
                source.disconnect();
              } catch {}
              sourceRef.current = null;
            }
            onEnded?.();
          };

          // Start from sample 0 deterministically
          source.start(0, 0);
        } else {
          const { createAudioPlayer } = await import("expo-audio");
          const base64 = _arrayBufferToBase64(buffer);
          const uri = `data:audio/mpeg;base64,${base64}`;
          const player = createAudioPlayer({ uri });
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
          player.addListener("playbackStatusUpdate", (status: any) => {
            if (status.didJustFinish && !didEnd) {
              didEnd = true;
              setIsPlaying(false);
              onEnded?.();
            } else if (!status.isLoaded) {
              setIsPlaying(false);
            }
          });
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
    if (sourceRef.current) {
      try {
        sourceRef.current.playbackRate.value = rate;
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

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const recorder = useExpoAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const webMediaRef = useRef<MediaRecorder | null>(null);
  const webChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    AudioModule.requestRecordingPermissionsAsync().then(({ granted }) => {
      setHasPermission(granted);
    });
  }, []);

  const startRecording = useCallback(async (): Promise<boolean> => {
    if (!hasPermission) {
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      setHasPermission(granted);
      if (!granted) return false;
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
  }, [hasPermission, recorder]);

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

        const FileSystem = await import("expo-file-system");
        const base64 = await FileSystem.default.readAsStringAsync(uri, {
          encoding: "base64" as any,
        });
        const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        return new Blob([byteArray], { type: "audio/wav" });
      }
    } catch {
      return null;
    }
  }, [isRecording, recorder]);

  return { startRecording, stopRecording, isRecording, hasPermission };
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  const response = await fetch(`${BASE_URL}/api/language/stt`, {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: arrayBuffer,
  });

  if (!response.ok) throw new Error("Transcription failed");
  const data = await response.json() as { success: boolean; transcript: string };
  return data.transcript;
}
