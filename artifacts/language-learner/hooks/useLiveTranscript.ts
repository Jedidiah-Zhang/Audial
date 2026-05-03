import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";

/**
 * Live on-device speech recognition that runs *alongside* an active
 * audio recording in the recitation stage. The user-facing goal is to
 * give immediate visual feedback while they speak — the authoritative
 * score still comes from the server-side Whisper pipeline once the
 * recording stops, so this hook is intentionally best-effort:
 *   - any failure (no platform support, permission denied,
 *     language not supported, mid-session network/no-speech error)
 *     silently flips `isAvailable` to `false` and is reported via
 *     `error` for UI hinting, but never throws and never blocks the
 *     surrounding recording flow.
 *   - the recognizer is started/stopped explicitly by the consumer
 *     so it can be perfectly synchronized with the audio recorder.
 *
 * Web uses the browser's `webkitSpeechRecognition` (via the
 * expo-speech-recognition web shim, which transparently delegates to
 * the Web Speech API). iOS / Android use the native module backed by
 * SFSpeechRecognizer / Android's SpeechRecognizer.
 */
export interface LiveTranscript {
  /** Words the recognizer has finalized so far this session. */
  finalTranscript: string;
  /** Currently-being-refined hypothesis. Stays empty between utterances. */
  interimTranscript: string;
  /**
   * Whether live transcription appears to be available for this
   * platform + language right now. Starts as `null` (unknown) until we
   * try to start a session, after which it's a hard `true` / `false`.
   */
  isLiveTranscriptAvailable: boolean | null;
  /** Most recent error code we observed, for diagnostic UI. */
  error: string | null;
  /** Begin a recognition session in the given BCP-47 language. */
  start: (languageCode: string) => Promise<void>;
  /** Stop the current session if any. Safe to call repeatedly. */
  stop: () => void;
  /** Clear interim/final transcript without touching availability. */
  reset: () => void;
}

export function useLiveTranscript(): LiveTranscript {
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isLiveTranscriptAvailable, setIsLiveTranscriptAvailable] = useState<
    boolean | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether we currently hold an active recognition session, so
  // `stop()` can be a no-op when nothing is running and we don't double
  // up on listener removal.
  const activeRef = useRef(false);
  const subsRef = useRef<{ remove: () => void }[]>([]);

  const cleanupSubscriptions = useCallback(() => {
    for (const sub of subsRef.current) {
      try {
        sub.remove();
      } catch {
        /* ignore — best effort */
      }
    }
    subsRef.current = [];
  }, []);

  const stop = useCallback(() => {
    if (!activeRef.current) {
      cleanupSubscriptions();
      return;
    }
    activeRef.current = false;
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        /* swallow — recognizer was never running cleanly */
      }
    }
    cleanupSubscriptions();
  }, [cleanupSubscriptions]);

  const reset = useCallback(() => {
    setFinalTranscript("");
    setInterimTranscript("");
    setError(null);
  }, []);

  const start = useCallback(
    async (languageCode: string) => {
      // Always reset previous text so a re-recorded attempt starts blank.
      setFinalTranscript("");
      setInterimTranscript("");
      setError(null);

      // Web: feature-detect the underlying API up front so we can flip
      // availability without provoking a permission prompt for browsers
      // that don't support it (Firefox stable, etc).
      if (Platform.OS === "web") {
        const w = globalThis as unknown as {
          webkitSpeechRecognition?: unknown;
          SpeechRecognition?: unknown;
        };
        if (!w.webkitSpeechRecognition && !w.SpeechRecognition) {
          setIsLiveTranscriptAvailable(false);
          return;
        }
      } else {
        // Native: ask the module if a recognizer exists at all.
        try {
          if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
            setIsLiveTranscriptAvailable(false);
            return;
          }
        } catch {
          setIsLiveTranscriptAvailable(false);
          return;
        }
        // Make sure we have *both* mic and speech-recognition permission
        // before starting, otherwise the native side throws synchronously
        // and we'd surface a noisy red box.
        try {
          const current =
            await ExpoSpeechRecognitionModule.getPermissionsAsync();
          if (!current.granted) {
            const requested =
              await ExpoSpeechRecognitionModule.requestPermissionsAsync();
            if (!requested.granted) {
              setIsLiveTranscriptAvailable(false);
              setError("not-allowed");
              return;
            }
          }
        } catch {
          setIsLiveTranscriptAvailable(false);
          return;
        }
      }

      // Subscribe to result + error + end events. We use the module's
      // own event emitter (not `useSpeechRecognitionEvent`) so we can
      // tear listeners down deterministically when the consumer stops
      // the session — `useSpeechRecognitionEvent` keeps a global
      // singleton listener which would otherwise live across sessions.
      cleanupSubscriptions();
      const onResult = (ev: ExpoSpeechRecognitionResultEvent) => {
        const text = ev.results?.[0]?.transcript ?? "";
        if (ev.isFinal) {
          // Append to the running final transcript and clear interim.
          setFinalTranscript((prev) => {
            if (!text) return prev;
            const sep = prev && !/\s$/.test(prev) ? " " : "";
            return prev + sep + text;
          });
          setInterimTranscript("");
        } else {
          setInterimTranscript(text);
        }
      };
      const onError = (ev: ExpoSpeechRecognitionErrorEvent) => {
        // Per task spec: never surface a blocking error. Just stop
        // updating the live transcript and let the recording continue.
        // Any error means the recognizer has effectively stopped, so
        // we flip availability to false — otherwise the UI would keep
        // showing "Listening…" even though no more updates will
        // arrive, which is misleading.
        setError(ev.error ?? "unknown");
        setIsLiveTranscriptAvailable(false);
        activeRef.current = false;
        cleanupSubscriptions();
      };
      const onEnd = () => {
        // Native sometimes auto-ends after a silence window even when
        // we asked for continuous=true. We treat that as the session
        // being over; the consumer can call start() again on retry.
        activeRef.current = false;
        cleanupSubscriptions();
      };

      try {
        subsRef.current.push(
          ExpoSpeechRecognitionModule.addListener("result", onResult),
        );
        subsRef.current.push(
          ExpoSpeechRecognitionModule.addListener("error", onError),
        );
        subsRef.current.push(
          ExpoSpeechRecognitionModule.addListener("end", onEnd),
        );
      } catch {
        cleanupSubscriptions();
        setIsLiveTranscriptAvailable(false);
        return;
      }

      try {
        ExpoSpeechRecognitionModule.start({
          lang: languageCode || "en-US",
          interimResults: true,
          continuous: true,
          maxAlternatives: 1,
        });
        activeRef.current = true;
        setIsLiveTranscriptAvailable(true);
      } catch {
        cleanupSubscriptions();
        activeRef.current = false;
        setIsLiveTranscriptAvailable(false);
      }
    },
    [cleanupSubscriptions],
  );

  useEffect(() => {
    return () => {
      // Mirror `stop()` on unmount but inline so we don't hold a ref to
      // the latest closure. Recognizer + listeners must always be torn
      // down to avoid leaking native callbacks across screens.
      if (activeRef.current) {
        try {
          ExpoSpeechRecognitionModule.abort();
        } catch {
          /* ignore */
        }
        activeRef.current = false;
      }
      for (const sub of subsRef.current) {
        try {
          sub.remove();
        } catch {
          /* ignore */
        }
      }
      subsRef.current = [];
    };
  }, []);

  return {
    finalTranscript,
    interimTranscript,
    isLiveTranscriptAvailable,
    error,
    start,
    stop,
    reset,
  };
}
