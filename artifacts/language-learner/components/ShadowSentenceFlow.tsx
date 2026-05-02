import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Headphones,
  Play,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioPlayer, useAudioRecorder, transcribeAudio, prefetchTTS } from "@/hooks/useAudio";
import { useMicPermissionGate } from "@/components/MicPermissionPrompt";
import { AudioWaveform } from "@/components/AudioWaveform";
import { Icon } from "@/components/Icon";
import { rtlTextStyle } from "@/utils/rtl";
import { useT } from "@/utils/i18n";
import type { ContentType } from "@/types";
import { CONTENT_TYPE_META, detectContentType } from "@/utils/contentType";
import { buildSentenceLayout, flattenSentences } from "@/utils/sentences";
import { getContentTypeLabel } from "@/utils/i18n";
import { sanitizeAnnotations } from "@/utils/annotations";
import type { Annotation } from "@/components/AnnotatedText";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export interface ShadowFlowResult {
  score: number;
  feedback: string;
  fluency?: number;
  accuracy?: number;
  targetAnnotations?: Annotation[];
  userTranscript?: string;
  recordingUri?: string | null;
}

interface ScorePronunciationResponse {
  success: boolean;
  data?: {
    score?: number;
    feedback?: string;
    fluency?: number;
    accuracy?: number;
    targetAnnotations?: unknown;
    [key: string]: unknown;
  };
  error?: string;
}

type FlowPhase =
  | "playing"
  | "ready"
  | "recording"
  | "full-read-intro"
  | "full-playing"
  | "full-recording"
  | "full-scoring"
  | "full-error-no-audio"
  | "full-error-transcribe"
  | "full-error-score"
  | "done";

interface SentenceState {
  listened: boolean;
  recorded: boolean;
}

const REQUEST_TIMEOUT_MS = 60000;

// Per-character TTS duration estimate. CJK characters are slower than
// Latin syllables in OpenAI TTS Nova at 1× speed. Used to set the hard
// auto-stop on the full read-through (we multiply by 2.5 below).
function estimateTtsMs(text: string): number {
  if (!text) return 0;
  let ms = 0;
  for (const ch of text) {
    if (/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(ch)) {
      ms += 200;
    } else {
      ms += 70;
    }
  }
  return Math.max(2000, ms);
}

interface Props {
  text: string;
  voice: string;
  accentColor: string;
  contentType?: ContentType;
  articleId?: string;
  language: string;
  onComplete: (result: ShadowFlowResult) => void;
}

export function ShadowSentenceFlow({
  text,
  voice,
  accentColor,
  contentType,
  articleId,
  language,
  onComplete,
}: Props) {
  const colors = useColors();
  const t = useT();
  const navigation = useNavigation();
  const { userId, settings } = useApp();
  const player = useAudioPlayer({ articleId, userId });
  const recordingPlayer = useAudioPlayer({ articleId, userId });
  const {
    startRecording,
    stopRecording,
    permission,
    requestPermission,
    openAppSettings,
    lastRecordingUri,
    clearLastRecording,
  } = useAudioRecorder();
  const { requestAccess: requestMicAccess, modal: micPermissionModal } =
    useMicPermissionGate({ permission, requestPermission, openAppSettings });

  const effectiveType: ContentType = useMemo(
    () => contentType ?? detectContentType(text),
    [contentType, text]
  );
  const layout = useMemo(
    () => buildSentenceLayout(text, effectiveType),
    [effectiveType, text]
  );
  const sentences = useMemo(() => flattenSentences(layout), [layout]);

  // Total estimated TTS time across the whole passage; the full read-through
  // gets a hard auto-stop at 2.5× this value.
  const totalEstimatedMs = useMemo(
    () => sentences.reduce((s, x) => s + estimateTtsMs(x), 0),
    [sentences]
  );

  const [currentIdx, setCurrentIdx] = useState(0);
  const [phase, setPhase] = useState<FlowPhase>("playing");
  const [states, setStates] = useState<SentenceState[]>(() =>
    sentences.map(() => ({ listened: false, recorded: false }))
  );
  const [recElapsedMs, setRecElapsedMs] = useState(0);
  const [isPlayingMyRecording, setIsPlayingMyRecording] = useState(false);
  // Cache the last successful full-passage transcript so the user can retry
  // just the scoring step (without re-recording) when the score endpoint
  // fails.
  const [lastFullTranscript, setLastFullTranscript] = useState<string>("");
  // Why the most recent full-passage recording produced no audio. Used to
  // pick the right copy on the "no audio" error screen — pointing the
  // user at mic permission only when permission really isn't granted,
  // and otherwise at the more likely real causes (mic in use elsewhere,
  // very short take, transient hardware error). The gate normally keeps
  // us out of the "permission" branch, but we keep it as a fallback in
  // case state drifts.
  const [noAudioReason, setNoAudioReason] = useState<"permission" | "capture">(
    "capture",
  );

  const statesRef = useRef<SentenceState[]>(states);
  const updateStates = useCallback(
    (updater: (prev: SentenceState[]) => SentenceState[]) => {
      const next = updater(statesRef.current);
      statesRef.current = next;
      setStates(next);
      return next;
    },
    []
  );

  const completedRef = useRef(false);
  const playGenRef = useRef(0);
  const fullPlayCancelRef = useRef<(() => void) | null>(null);
  const recTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recStartRef = useRef<number>(0);
  const playbackWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // useAudioRecorder exposes lastRecordingUri as state, which means our
  // async scoring callback closes over the value at the time the callback
  // was created — i.e. usually `null` because the recording hadn't been
  // captured yet. The state updates during stopRecording, but our running
  // closure can't see the new value. Mirror the state into a ref so we
  // always read the latest URI when assembling the onComplete payload.
  const lastRecordingUriRef = useRef<string | null>(null);
  useEffect(() => {
    lastRecordingUriRef.current = lastRecordingUri;
  }, [lastRecordingUri]);

  // Scroll refs for the per-sentence loop card.
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const rowRefs = useRef<Map<number, View | null>>(new Map());

  const clearPlaybackWatchdog = useCallback(() => {
    if (playbackWatchdogRef.current) {
      clearTimeout(playbackWatchdogRef.current);
      playbackWatchdogRef.current = null;
    }
  }, []);

  // Prefetch every sentence's TTS in the background so playback during the
  // flow is snappy. Best-effort — silent on failure.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const s of sentences) {
        if (cancelled) return;
        await prefetchTTS(s, voice, { userId, articleId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sentences, voice, userId, articleId]);

  const playSentence = useCallback(
    (idx: number) => {
      if (idx >= sentences.length) return;
      clearPlaybackWatchdog();
      const gen = ++playGenRef.current;
      setPhase("playing");
      try {
        player.playTTS(sentences[idx], voice, () => {
          if (gen !== playGenRef.current) return;
          clearPlaybackWatchdog();
          setPhase("ready");
          // Mark this sentence as listened the moment playback completes —
          // this is the gate that unlocks the "Start full read" CTA.
          updateStates((prev) =>
            prev.map((s, i) => (i === idx ? { ...s, listened: true } : s))
          );
        });
      } catch {
        if (gen === playGenRef.current) {
          setPhase("ready");
          updateStates((prev) =>
            prev.map((s, i) => (i === idx ? { ...s, listened: true } : s))
          );
        }
        return;
      }
      // Safety net: if the playback callback never fires (TTS network error,
      // audio backend hiccup, etc.) the user would be stranded in "playing"
      // with the mic disabled. Estimate a generous upper bound and auto-
      // recover to "ready" so the flow is never permanently stuck.
      const estMs = Math.max(8000, Math.min(60000, estimateTtsMs(sentences[idx]) * 2));
      playbackWatchdogRef.current = setTimeout(() => {
        if (gen !== playGenRef.current) return;
        playbackWatchdogRef.current = null;
        setPhase("ready");
        updateStates((prev) =>
          prev.map((s, i) => (i === idx ? { ...s, listened: true } : s))
        );
      }, estMs);
    },
    [sentences, voice, player, clearPlaybackWatchdog, updateStates]
  );

  // Kick off the very first sentence on mount.
  useEffect(() => {
    if (sentences.length === 0) {
      // Empty article — nothing to score. Report a 0 so the result page
      // doesn't get stuck in a bad state.
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete({ score: 0, feedback: "" });
      }
      return;
    }
    playSentence(0);
    return () => {
      clearPlaybackWatchdog();
      try {
        player.stop();
      } catch {}
      try {
        recordingPlayer.stop();
      } catch {}
      if (recTickRef.current) clearInterval(recTickRef.current);
      if (recAutoStopRef.current) clearTimeout(recAutoStopRef.current);
      if (fullPlayCancelRef.current) fullPlayCancelRef.current();
    };
    // Intentionally only run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── leave-confirmation dialog ─────────────────────────────────────────
  // Intercepts the screen-level "back" navigation so we can confirm before
  // throwing away in-progress shadow practice. Once `completedRef.current`
  // is set (the parent has switched to the result view) the listener
  // becomes a no-op so navigating back from the result page is friction-
  // less.
  useEffect(() => {
    const sub = navigation.addListener("beforeRemove", (e: unknown) => {
      if (completedRef.current) return;
      const event = e as {
        preventDefault: () => void;
        data: { action: unknown };
      };
      event.preventDefault();
      const isFullRecording =
        phase === "full-recording" || phase === "full-scoring";
      Alert.alert(
        isFullRecording
          ? t("session.shadow.leaveFullTitle")
          : t("session.shadow.leaveTitle"),
        isFullRecording
          ? t("session.shadow.leaveFullBody")
          : t("session.shadow.leaveBody"),
        [
          { text: t("session.shadow.leaveStay"), style: "cancel" },
          {
            text: t("session.shadow.leaveDiscard"),
            style: "destructive",
            onPress: () => {
              completedRef.current = true;
              (navigation as unknown as {
                dispatch: (action: unknown) => void;
              }).dispatch(event.data.action);
            },
          },
        ]
      );
    });
    return sub;
  }, [navigation, phase, t]);

  // ── per-sentence loop ─────────────────────────────────────────────────

  const handleMicPress = useCallback(async () => {
    if (phase === "recording") {
      // Tap to stop. We stash the recording (the URI is exposed by the
      // recorder hook for "Play my recording") and stay on the same
      // sentence — no scoring, no auto-advance.
      await stopRecording();
      setPhase("ready");
      updateStates((prev) =>
        prev.map((s, i) => (i === currentIdx ? { ...s, recorded: true } : s))
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    }
    if (phase === "ready" || phase === "playing") {
      // Force-stop any TTS before recording so the mic doesn't pick up the
      // model voice's tail.
      try {
        player.stop();
      } catch {}
      playGenRef.current++;
      clearPlaybackWatchdog();
      requestMicAccess(async () => {
        const ok = await startRecording();
        if (!ok) return;
        setPhase("recording");
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      });
    }
  }, [
    phase,
    player,
    stopRecording,
    startRecording,
    requestMicAccess,
    currentIdx,
    updateStates,
    clearPlaybackWatchdog,
  ]);

  const handleReplayCurrent = useCallback(() => {
    if (phase === "recording") return;
    playSentence(currentIdx);
  }, [phase, playSentence, currentIdx]);

  const handlePlayMyRecording = useCallback(() => {
    if (!lastRecordingUri) return;
    if (phase === "recording") return;
    try {
      player.stop();
    } catch {}
    playGenRef.current++;
    setIsPlayingMyRecording(true);
    recordingPlayer.playRecording(lastRecordingUri, () => {
      setIsPlayingMyRecording(false);
    });
  }, [lastRecordingUri, phase, player, recordingPlayer]);

  const handleStopMyRecording = useCallback(() => {
    try {
      recordingPlayer.stop();
    } catch {}
    setIsPlayingMyRecording(false);
  }, [recordingPlayer]);

  const goToSentence = useCallback(
    (nextIdx: number) => {
      if (nextIdx < 0 || nextIdx >= sentences.length) return;
      if (phase === "recording") return;
      try {
        player.stop();
      } catch {}
      try {
        recordingPlayer.stop();
      } catch {}
      setIsPlayingMyRecording(false);
      // Discard the previous sentence's recording — "Play my recording" is
      // a per-sentence convenience, not a history.
      clearLastRecording();
      setCurrentIdx(nextIdx);
      playSentence(nextIdx);
    },
    [sentences.length, phase, player, recordingPlayer, clearLastRecording, playSentence]
  );

  const handleNext = useCallback(() => {
    goToSentence(currentIdx + 1);
  }, [currentIdx, goToSentence]);

  const handlePrev = useCallback(() => {
    goToSentence(currentIdx - 1);
  }, [currentIdx, goToSentence]);

  // Tapping any sentence in the article jumps to it (and starts playback).
  const replayAny = useCallback(
    (idx: number) => {
      if (phase === "recording") return;
      if (idx === currentIdx) {
        playSentence(idx);
        return;
      }
      goToSentence(idx);
    },
    [phase, currentIdx, playSentence, goToSentence]
  );

  // Auto-scroll the current sentence into view whenever currentIdx changes.
  // See task-46 notes for why we use measureInWindow instead of
  // measureLayout: avoids Fabric / react-native-web crashes.
  useEffect(() => {
    const row = rowRefs.current.get(currentIdx);
    const sv = scrollRef.current;
    const content = contentRef.current;
    if (!row || !sv || !content) return;
    type MeasureFn = (
      cb: (x: number, y: number, w: number, h: number) => void
    ) => void;
    type WebScrollFn = (opts?: { behavior?: string; block?: string }) => void;
    const rowAny = row as unknown as {
      measureInWindow?: MeasureFn;
      scrollIntoView?: WebScrollFn;
    };
    const contentAny = content as unknown as { measureInWindow?: MeasureFn };
    const tid = setTimeout(() => {
      try {
        if (
          typeof rowAny.measureInWindow === "function" &&
          typeof contentAny.measureInWindow === "function"
        ) {
          contentAny.measureInWindow((_cx, cy) => {
            try {
              if (!Number.isFinite(cy)) return;
              rowAny.measureInWindow!((_rx, ry) => {
                try {
                  if (!Number.isFinite(ry)) return;
                  const target = Math.max(0, ry - cy - 24);
                  sv.scrollTo({ y: target, animated: true });
                } catch {}
              });
            } catch {}
          });
          return;
        }
        if (Platform.OS === "web" && typeof rowAny.scrollIntoView === "function") {
          rowAny.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } catch {}
    }, 50);
    return () => clearTimeout(tid);
  }, [currentIdx]);

  // ── full read-through ─────────────────────────────────────────────────

  const cancelFullPlay = useCallback(() => {
    if (fullPlayCancelRef.current) {
      fullPlayCancelRef.current();
      fullPlayCancelRef.current = null;
    }
  }, []);

  const enterFullReadIntro = useCallback(() => {
    if (phase === "recording") return;
    try {
      player.stop();
    } catch {}
    playGenRef.current++;
    clearPlaybackWatchdog();
    try {
      recordingPlayer.stop();
    } catch {}
    setIsPlayingMyRecording(false);
    setPhase("full-read-intro");
  }, [phase, player, recordingPlayer, clearPlaybackWatchdog]);

  // Whether the user has heard every sentence at least once. Used both
  // by the per-sentence loop UI (to enable the "continue" CTA) and by
  // the auto-advance effect right below.
  const allListened = states.length > 0 && states.every((s) => s.listened);

  // First time the user has heard every sentence at least once, slide
  // into the full-read intro card automatically — this is the
  // "transition card" UX that signals the listening half is done. The
  // flag prevents re-triggering if the user backs out of the intro and
  // returns to the loop, so the CTA still works as a manual re-entry.
  //
  // This ref + effect MUST live up here at the top of the component
  // alongside the other hooks. They previously lived after the
  // `sentences.length === 0` and `phase === "full-*"` early returns,
  // which meant the render that switched into a full-passage phase
  // called fewer hooks than the previous render — violating the Rules
  // of Hooks and producing a "Rendered fewer hooks than expected"
  // crash exactly at the moment of the auto-advance.
  const autoIntroFiredRef = useRef(false);
  useEffect(() => {
    if (
      allListened &&
      !autoIntroFiredRef.current &&
      (phase === "ready" || phase === "playing")
    ) {
      autoIntroFiredRef.current = true;
      enterFullReadIntro();
    }
  }, [allListened, phase, enterFullReadIntro]);

  const playFullPassage = useCallback(() => {
    cancelFullPlay();
    let cancelled = false;
    let i = 0;
    const playNext = () => {
      if (cancelled) return;
      if (i >= sentences.length) {
        fullPlayCancelRef.current = null;
        setPhase("full-read-intro");
        return;
      }
      const idx = i++;
      try {
        player.playTTS(sentences[idx], voice, () => {
          if (cancelled) return;
          playNext();
        });
      } catch {
        if (!cancelled) playNext();
      }
    };
    fullPlayCancelRef.current = () => {
      cancelled = true;
      try {
        player.stop();
      } catch {}
    };
    setPhase("full-playing");
    playNext();
  }, [cancelFullPlay, sentences, voice, player]);

  const stopFullPlayback = useCallback(() => {
    cancelFullPlay();
    setPhase("full-read-intro");
  }, [cancelFullPlay]);

  const scoreFullPassage = useCallback(
    async (transcript: string) => {
      setPhase("full-scoring");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${BASE_URL}/api/language/score-pronunciation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetText: text,
            transcribedText: transcript,
            language,
          }),
          signal: controller.signal,
        });
        const json: ScorePronunciationResponse = await response.json();
        if (!json.success || !json.data) throw new Error("Scoring failed");
        const d = json.data;
        const score: number = typeof d.score === "number" ? d.score : 0;
        const targetAnnotations =
          sanitizeAnnotations(d.targetAnnotations as never, text) ?? undefined;
        completedRef.current = true;
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onComplete({
          score,
          feedback: typeof d.feedback === "string" ? d.feedback : "",
          fluency: typeof d.fluency === "number" ? d.fluency : undefined,
          accuracy: typeof d.accuracy === "number" ? d.accuracy : undefined,
          targetAnnotations,
          userTranscript: transcript,
          recordingUri: lastRecordingUriRef.current ?? null,
        });
      } catch {
        setPhase("full-error-score");
      } finally {
        clearTimeout(timer);
      }
    },
    [text, language, onComplete]
  );

  const finalizeFullRecording = useCallback(async () => {
    if (recTickRef.current) {
      clearInterval(recTickRef.current);
      recTickRef.current = null;
    }
    if (recAutoStopRef.current) {
      clearTimeout(recAutoStopRef.current);
      recAutoStopRef.current = null;
    }
    setPhase("full-scoring");
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    const blob = await Promise.race<Blob | null>([
      stopRecording().then((b) => {
        if (stopTimer) clearTimeout(stopTimer);
        return b;
      }),
      new Promise<null>((resolve) => {
        stopTimer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
      }),
    ]);
    if (!blob) {
      // The recorder returned no bytes. If permission really isn't
      // granted any more (revoked between sessions, etc.) tell the user
      // to fix permission; otherwise point them at the more likely
      // causes — another app holding the mic, an extremely short take,
      // or a transient hardware glitch.
      setNoAudioReason(permission === "granted" ? "capture" : "permission");
      setPhase("full-error-no-audio");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const transcript = await transcribeAudio(blob, controller.signal);
      if (!transcript || !transcript.trim()) {
        setPhase("full-error-transcribe");
        return;
      }
      const cleaned = transcript.trim();
      setLastFullTranscript(cleaned);
      await scoreFullPassage(cleaned);
    } catch {
      setPhase("full-error-transcribe");
    } finally {
      clearTimeout(timer);
    }
  }, [stopRecording, scoreFullPassage, permission]);

  const startFullRecording = useCallback(async () => {
    cancelFullPlay();
    try {
      player.stop();
    } catch {}
    playGenRef.current++;
    clearPlaybackWatchdog();
    requestMicAccess(async () => {
      const ok = await startRecording();
      if (!ok) return;
      setPhase("full-recording");
      setRecElapsedMs(0);
      recStartRef.current = Date.now();
      // Tick the elapsed display every 250ms while we're recording.
      if (recTickRef.current) clearInterval(recTickRef.current);
      recTickRef.current = setInterval(() => {
        setRecElapsedMs(Date.now() - recStartRef.current);
      }, 250);
      // Hard auto-stop at 2.5× the estimated TTS duration. Floors at 15s
      // so very short passages still give the user time to start speaking.
      const cap = Math.max(15000, Math.round(totalEstimatedMs * 2.5));
      if (recAutoStopRef.current) clearTimeout(recAutoStopRef.current);
      recAutoStopRef.current = setTimeout(() => {
        finalizeFullRecording();
      }, cap);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    });
  }, [
    cancelFullPlay,
    player,
    clearPlaybackWatchdog,
    requestMicAccess,
    startRecording,
    totalEstimatedMs,
    finalizeFullRecording,
  ]);

  const handleFullStop = useCallback(() => {
    if (phase !== "full-recording") return;
    finalizeFullRecording();
  }, [phase, finalizeFullRecording]);

  const handleRetryFullRecord = useCallback(() => {
    setLastFullTranscript("");
    setPhase("full-read-intro");
  }, []);

  const handleRetryFullScore = useCallback(() => {
    if (!lastFullTranscript) {
      setPhase("full-read-intro");
      return;
    }
    scoreFullPassage(lastFullTranscript);
  }, [lastFullTranscript, scoreFullPassage]);

  // ── rendering ─────────────────────────────────────────────────────────

  const meta = CONTENT_TYPE_META[effectiveType];
  const Badge = meta.showBadge ? (
    <View style={[styles.contentTypeBadge, { backgroundColor: accentColor + "18" }]}>
      <Icon name={meta.icon} size={10} color={accentColor} />
      <Text style={[styles.contentTypeBadgeText, { color: accentColor }]}>
        {getContentTypeLabel(effectiveType, settings.nativeLanguage)}
      </Text>
    </View>
  ) : null;

  const replayDisabled = phase === "recording";

  const renderSentenceRow = (globalIdx: number, sent: string) => {
    const st = states[globalIdx];
    const isCurrent = globalIdx === currentIdx;
    let bg: string | undefined;
    let color = colors.foreground;
    let opacity = 1;
    let borderColor = "transparent";
    if (isCurrent) {
      bg = accentColor + "1F";
      color = accentColor;
      borderColor = accentColor + "55";
    } else if (st?.listened) {
      bg = colors.muted;
    } else {
      opacity = 0.55;
    }
    // Status dot: filled accent when the user has recorded themselves on
    // this sentence; muted dot when listened only; nothing when untouched.
    // Deliberately neutral — no pass/fail signal here.
    const dotColor = st?.recorded
      ? accentColor
      : st?.listened
      ? colors.mutedForeground
      : "transparent";
    const playColor = isCurrent ? accentColor : colors.mutedForeground;
    return (
      <Pressable
        key={globalIdx}
        ref={(r) => {
          rowRefs.current.set(globalIdx, r as unknown as View | null);
        }}
        onPress={() => replayAny(globalIdx)}
        disabled={replayDisabled}
        accessibilityRole="button"
        accessibilityLabel={`${t("session.shadow.replayThis")} ${globalIdx + 1}`}
        style={({ pressed }) => [
          styles.sentRow,
          {
            backgroundColor: bg,
            borderColor,
            opacity: pressed ? 0.7 : opacity,
          },
        ]}
      >
        <View
          style={[
            styles.playIconWrap,
            { backgroundColor: playColor + "1A", borderColor: playColor + "33" },
          ]}
        >
          <Play size={11} color={playColor} fill={playColor} />
        </View>
        <Text style={[styles.sentText, { color }, rtlTextStyle(sent)]}>{sent}</Text>
        <View
          style={[
            styles.statusDot,
            dotColor === "transparent"
              ? { backgroundColor: "transparent" }
              : { backgroundColor: dotColor },
          ]}
        />
      </Pressable>
    );
  };

  const renderArticle = () => {
    if (layout.kind === "dialogue") {
      let cursor = 0;
      return (
        <View ref={contentRef} style={styles.dialogueWrap}>
          {Badge}
          {layout.groups.map((g, gi) => {
            const isAlt = gi % 2 === 1;
            return (
              <View key={gi} style={[styles.turn, isAlt && styles.turnAlt]}>
                <View
                  style={[
                    styles.speakerChip,
                    { backgroundColor: isAlt ? accentColor + "18" : colors.muted },
                  ]}
                >
                  <Text
                    style={[
                      styles.speakerText,
                      { color: isAlt ? accentColor : colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {g.speaker}
                  </Text>
                </View>
                <View
                  style={[
                    styles.bubble,
                    {
                      backgroundColor: isAlt ? accentColor + "10" : colors.muted,
                      alignSelf: isAlt ? "flex-end" : "flex-start",
                      borderColor: isAlt ? accentColor + "33" : colors.border,
                    },
                  ]}
                >
                  {g.sentences.map((s) => {
                    const idx = cursor++;
                    return renderSentenceRow(idx, s);
                  })}
                </View>
              </View>
            );
          })}
        </View>
      );
    }
    let cursor = 0;
    return (
      <View ref={contentRef} style={styles.newsWrap}>
        {Badge}
        {layout.groups.map((g, gi) => (
          <View key={gi} style={styles.paragraphBlock}>
            {g.sentences.map((s) => {
              const idx = cursor++;
              return renderSentenceRow(idx, s);
            })}
          </View>
        ))}
      </View>
    );
  };

  if (sentences.length === 0) {
    // Edge case handled in the mount effect; render an empty placeholder.
    return <View />;
  }

  // Non-loop screens render their own self-contained UI.
  if (
    phase === "full-read-intro" ||
    phase === "full-playing" ||
    phase === "full-recording" ||
    phase === "full-scoring" ||
    phase === "full-error-no-audio" ||
    phase === "full-error-transcribe" ||
    phase === "full-error-score" ||
    phase === "done"
  ) {
    return (
      <View style={styles.wrap}>
        {renderFullPassageScreen()}
        {micPermissionModal}
      </View>
    );
  }

  // ── per-sentence loop screen ──────────────────────────────────────────
  // `allListened` and the auto-advance effect that consumes it have
  // been hoisted up next to `enterFullReadIntro` so that no hooks live
  // after the early returns above. See the comment block at that
  // declaration for the full story.
  const loopHint =
    phase === "recording"
      ? t("session.shadow.stopHint")
      : t("session.shadow.guidedHint");
  const isLast = currentIdx >= sentences.length - 1;

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={[styles.progressBarTrack, { backgroundColor: colors.muted }]}>
          {(() => {
            const listenedCount = states.filter((s) => s.listened).length;
            const pct =
              sentences.length === 0
                ? 0
                : Math.round((listenedCount / sentences.length) * 100);
            const widthValue: `${number}%` = `${pct}%`;
            return (
              <View
                style={[
                  styles.progressBarFill,
                  { backgroundColor: accentColor, width: widthValue },
                ]}
              />
            );
          })()}
        </View>
        <ScrollView
          ref={scrollRef}
          style={{ maxHeight: 320 }}
          contentContainerStyle={{ paddingRight: 4 }}
          showsVerticalScrollIndicator
          nestedScrollEnabled
        >
          {renderArticle()}
        </ScrollView>
        <View style={[styles.progressRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.progressText, { color: colors.mutedForeground }]}>
            {t("session.shadow.sentenceProgress", {
              i: Math.min(currentIdx + 1, sentences.length),
              n: sentences.length,
            })}
          </Text>
          <TouchableOpacity
            onPress={handleReplayCurrent}
            disabled={replayDisabled}
            style={[
              styles.replayBtn,
              { borderColor: colors.border, opacity: replayDisabled ? 0.4 : 1 },
            ]}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <Volume2 size={14} color={accentColor} />
            <Text style={[styles.replayBtnText, { color: accentColor }]}>
              {t("session.shadow.replayThis")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.recordSection}>
        <TouchableOpacity
          onPress={handleMicPress}
          disabled={phase === "playing"}
          style={[
            styles.recordBtn,
            {
              backgroundColor: phase === "recording" ? "#EF4444" : accentColor,
              shadowColor: phase === "recording" ? "#EF4444" : accentColor,
              opacity: phase === "playing" ? 0.6 : 1,
            },
          ]}
          activeOpacity={0.85}
        >
          <Icon name={phase === "recording" ? "square" : "mic"} size={32} color="#fff" />
        </TouchableOpacity>
        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>{loopHint}</Text>
        {phase === "recording" ? <AudioWaveform isActive color="#EF4444" /> : null}

        {phase !== "recording" ? (
          <View style={styles.optionRow}>
            <TouchableOpacity
              onPress={handlePrev}
              disabled={currentIdx === 0}
              style={[
                styles.optBtn,
                { borderColor: colors.border, opacity: currentIdx === 0 ? 0.4 : 1 },
              ]}
              activeOpacity={0.85}
            >
              <ArrowLeft size={14} color={colors.foreground} />
              <Text style={[styles.optBtnText, { color: colors.foreground }]}>
                {t("session.shadow.prev")}
              </Text>
            </TouchableOpacity>
            {lastRecordingUri ? (
              <TouchableOpacity
                onPress={isPlayingMyRecording ? handleStopMyRecording : handlePlayMyRecording}
                style={[styles.optBtn, { borderColor: colors.border }]}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={t("session.shadow.playMyRecording")}
              >
                {isPlayingMyRecording ? (
                  <Square size={14} color={colors.foreground} />
                ) : (
                  <Headphones size={14} color={colors.foreground} />
                )}
                <Text style={[styles.optBtnText, { color: colors.foreground }]}>
                  {t("session.shadow.playMyRecording")}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={handleNext}
              disabled={isLast}
              style={[
                styles.optBtn,
                {
                  borderColor: accentColor,
                  backgroundColor: accentColor + "15",
                  opacity: isLast ? 0.4 : 1,
                },
              ]}
              activeOpacity={0.85}
            >
              <Text style={[styles.optBtnText, { color: accentColor }]}>
                {t("session.shadow.next")}
              </Text>
              <ArrowRight size={14} color={accentColor} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {/* CTA to (re-)enter the mandatory full read-through. Locked until
          every sentence has been heard at least once so the hint copy and
          button state stay consistent. The first unlock auto-opens the
          intro card; this CTA exists so users can return to it after
          backing out. */}
      <TouchableOpacity
        onPress={enterFullReadIntro}
        disabled={!allListened || phase === "recording"}
        style={[
          styles.fullReadCta,
          {
            backgroundColor: allListened ? accentColor : accentColor + "55",
            opacity: !allListened || phase === "recording" ? 0.6 : 1,
          },
        ]}
        activeOpacity={0.85}
      >
        <Headphones size={18} color="#fff" />
        <Text style={styles.fullReadCtaText}>{t("session.shadow.startFullRead")}</Text>
      </TouchableOpacity>
      {!allListened ? (
        <Text style={[styles.fullReadHint, { color: colors.mutedForeground }]}>
          {t("session.shadow.fullReadHint")}
        </Text>
      ) : null}

      {micPermissionModal}
    </View>
  );

  // ── full-passage screen renderer ──────────────────────────────────────
  function renderFullPassageScreen(): React.ReactNode {
    if (phase === "full-scoring") {
      return (
        <View style={[styles.centerBox, { padding: 30 }]}>
          <ActivityIndicator size="large" color={accentColor} />
          <Text style={[styles.centerText, { color: colors.mutedForeground }]}>
            {t("session.processing.scoring")}
          </Text>
        </View>
      );
    }

    if (phase === "full-read-intro" || phase === "full-playing") {
      const isPlaying = phase === "full-playing";
      return (
        <View style={styles.fullIntroWrap}>
          <View
            style={[
              styles.fullIntroCard,
              { backgroundColor: accentColor + "15", borderColor: accentColor + "55" },
            ]}
          >
            <Text style={styles.fullIntroEmoji}>👏</Text>
            <Text style={[styles.fullIntroTitle, { color: accentColor }]}>
              {t("session.shadow.fullIntro.title")}
            </Text>
            <Text style={[styles.fullIntroBody, { color: colors.foreground }]}>
              {t("session.shadow.fullIntro.body")}
            </Text>
          </View>
          <View
            style={[
              styles.passagePreview,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator>
              <Text style={[styles.passagePreviewText, { color: colors.foreground }, rtlTextStyle(text)]}>
                {text}
              </Text>
            </ScrollView>
          </View>
          <View style={styles.fullIntroActions}>
            <TouchableOpacity
              onPress={isPlaying ? stopFullPlayback : playFullPassage}
              style={[styles.optBtn, { borderColor: colors.border, paddingVertical: 12 }]}
              activeOpacity={0.85}
            >
              {isPlaying ? (
                <Square size={16} color={colors.foreground} />
              ) : (
                <Volume2 size={16} color={colors.foreground} />
              )}
              <Text style={[styles.optBtnText, { color: colors.foreground }]}>
                {isPlaying
                  ? t("session.shadow.fullIntro.stopListen")
                  : t("session.shadow.fullIntro.listen")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={startFullRecording}
              disabled={isPlaying}
              style={[
                styles.fullStartBtn,
                { backgroundColor: accentColor, opacity: isPlaying ? 0.5 : 1 },
              ]}
              activeOpacity={0.85}
            >
              <Icon name="mic" size={18} color="#fff" />
              <Text style={styles.fullStartBtnText}>
                {t("session.shadow.fullIntro.start")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    if (phase === "full-recording") {
      const seconds = Math.floor(recElapsedMs / 1000);
      const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
      const ss = String(seconds % 60).padStart(2, "0");
      return (
        <View style={styles.fullRecordWrap}>
          <View
            style={[
              styles.passageCard,
              { backgroundColor: colors.card, borderColor: accentColor + "55" },
            ]}
          >
            <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator>
              <Text style={[styles.passageBodyText, { color: colors.foreground }, rtlTextStyle(text)]}>
                {text}
              </Text>
            </ScrollView>
          </View>
          <View style={styles.fullRecordCenter}>
            <Text style={[styles.timerText, { color: "#EF4444" }]}>{`${mm}:${ss}`}</Text>
            <AudioWaveform isActive color="#EF4444" barCount={9} />
            <TouchableOpacity
              onPress={handleFullStop}
              style={[styles.recordBtn, { backgroundColor: "#EF4444", shadowColor: "#EF4444" }]}
              activeOpacity={0.85}
            >
              <Square size={32} color="#fff" />
            </TouchableOpacity>
            <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
              {t("session.shadow.fullStopHint")}
            </Text>
          </View>
        </View>
      );
    }

    if (
      phase === "full-error-no-audio" ||
      phase === "full-error-transcribe" ||
      phase === "full-error-score"
    ) {
      const titleKey =
        phase === "full-error-no-audio"
          ? "session.shadow.fullError.noAudio.title"
          : phase === "full-error-transcribe"
          ? "session.shadow.fullError.transcribe.title"
          : "session.shadow.fullError.score.title";
      const descKey =
        phase === "full-error-no-audio"
          ? noAudioReason === "capture"
            ? "session.shadow.fullError.noAudio.descCapture"
            : "session.shadow.fullError.noAudio.desc"
          : phase === "full-error-transcribe"
          ? "session.shadow.fullError.transcribe.desc"
          : "session.shadow.fullError.score.desc";
      return (
        <View style={styles.fullIntroWrap}>
          <View
            style={[
              styles.errorCard,
              { borderColor: "#EF444455", backgroundColor: "#EF44440F" },
            ]}
          >
            <View style={styles.errorHeader}>
              <AlertTriangle size={16} color="#EF4444" />
              <Text style={[styles.errorTitle, { color: "#EF4444" }]}>{t(titleKey)}</Text>
            </View>
            <Text style={[styles.errorDesc, { color: colors.mutedForeground }]}>
              {t(descKey)}
            </Text>
          </View>
          <View style={styles.fullIntroActions}>
            {phase === "full-error-score" ? (
              <TouchableOpacity
                onPress={handleRetryFullScore}
                style={[styles.fullStartBtn, { backgroundColor: accentColor }]}
                activeOpacity={0.85}
              >
                <RotateCcw size={16} color="#fff" />
                <Text style={styles.fullStartBtnText}>
                  {t("session.shadow.fullError.retryScore")}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={handleRetryFullRecord}
              style={[styles.optBtn, { borderColor: colors.border, paddingVertical: 12 }]}
              activeOpacity={0.85}
            >
              <RotateCcw size={16} color={colors.foreground} />
              <Text style={[styles.optBtnText, { color: colors.foreground }]}>
                {t("session.shadow.fullError.retryRead")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return null;
  }
}

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  textCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    maxHeight: 380,
  },
  progressBarTrack: {
    width: "100%",
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    marginBottom: 12,
  },
  progressBarFill: {
    height: "100%",
    borderRadius: 2,
  },
  sentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 6,
  },
  playIconWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  sentText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 8,
    marginLeft: 4,
  },
  paragraphBlock: {
    marginBottom: 6,
  },
  contentTypeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginBottom: 10,
  },
  contentTypeBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  dialogueWrap: { gap: 10 },
  turn: { gap: 4, alignItems: "flex-start" },
  turnAlt: { alignItems: "flex-end" },
  speakerChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    maxWidth: "60%",
  },
  speakerText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    maxWidth: "92%",
  },
  newsWrap: { gap: 4 },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  progressText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  replayBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  replayBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  recordSection: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  recordBtn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
      default: {},
    }),
  },
  hintText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 4,
  },
  optBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  optBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  fullReadCta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  fullReadCtaText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.3,
  },
  fullReadHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: -4,
  },
  centerBox: {
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingVertical: 40,
  },
  centerText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  fullIntroWrap: {
    gap: 16,
  },
  fullIntroCard: {
    borderRadius: 18,
    borderWidth: 1.5,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  fullIntroEmoji: {
    fontSize: 32,
  },
  fullIntroTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  fullIntroBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
    textAlign: "center",
  },
  passagePreview: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  passagePreviewText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  fullIntroActions: {
    gap: 10,
  },
  fullStartBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
      default: {},
    }),
  },
  fullStartBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  fullRecordWrap: {
    gap: 16,
  },
  passageCard: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
  },
  passageBodyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 24,
  },
  fullRecordCenter: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 16,
  },
  timerText: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
  },
  errorCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  errorHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
  },
  errorDesc: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: "Inter_400Regular",
  },
});
