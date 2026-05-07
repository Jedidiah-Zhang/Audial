import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
  ArrowLeft,
  ArrowRight,
  ArrowRightCircle,
  EyeOff,
  Headphones,
  Play,
  Square,
  Timer,
  Volume2,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioPlayer, useAudioRecorder, prefetchTTS } from "@/hooks/useAudio";
import { VOICE_OPTIONS } from "@/types";
import { useMicPermissionGate } from "@/components/MicPermissionPrompt";
import { AudioWaveform } from "@/components/AudioWaveform";
import { Icon } from "@/components/Icon";
import { rtlTextStyle } from "@/utils/rtl";
import { useT } from "@/utils/i18n";
import type { ContentType } from "@/types";
import { CONTENT_TYPE_META, detectContentType, normalizeContentType } from "@/utils/contentType";
import { buildSentenceLayout, flattenSentences } from "@/utils/sentences";
import { buildRecitationHintPlan } from "@/utils/recitationHint";
import { getContentTypeLabel } from "@/utils/i18n";
import {
  getSessionCloseRunner,
  setShadowLeaveIntercept,
} from "@/utils/sessionLeaveIntercept";

// Per-character TTS duration estimate (matches ShadowSentenceFlow). Used
// as a generous upper bound for the playback watchdog so the user can
// never get stranded in the "playing" state after a TTS hiccup.
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

// Per-sentence "look/listen → cover → recite" loop.
//   - preview     : original sentence is visible; TTS auto-plays once.
//   - memorizing  : original sentence still visible, short countdown ticking
//                   so the user can lock it into short-term memory. User can
//                   tap "I'm ready" to skip the countdown.
//   - reciting    : original sentence is hidden behind a mask; mic is armed
//                   so the user can recite from memory.
//   - reviewing   : original sentence is restored for self-comparison; the
//                   user can replay their own take, replay the original, or
//                   move on to the next sentence.
type FlowPhase = "preview" | "memorizing" | "reciting" | "reviewing";

// Per-sentence countdown for the "memorize" beat. Same shape as
// `computeMemorizeDuration` in session.tsx but tuned for a single
// sentence — base + per-token slope, clamped to a friendly range so
// the countdown never feels broken on tiny fragments or huge run-ons.
function computeSentenceMemorizeDuration(rawText: string): number {
  const trimmed = (rawText ?? "").trim();
  if (!trimmed) return 3;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const chars = Array.from(trimmed).length;
  const units = words > 1 ? words : Math.max(1, Math.round(chars / 2));
  const seconds = Math.round(2 + units * 0.6);
  return Math.min(15, Math.max(3, seconds));
}

interface SentenceState {
  listened: boolean;
  recorded: boolean;
}

interface Props {
  text: string;
  voice: string;
  accentColor: string;
  contentType?: ContentType;
  articleId?: string;
  onContinue: () => void;
}

const SPEED_OPTIONS: { label: string; value: number }[] = [
  { label: "0.5x", value: 0.5 },
  { label: "0.75x", value: 0.75 },
  { label: "1x", value: 1.0 },
];

/**
 * Per-sentence warm-up loop for the recitation stage.
 *
 * Mirrors the listen / record / replay rhythm of `ShadowSentenceFlow`'s
 * per-sentence loop, but is intentionally simpler:
 *
 *   - No scoring. The full passage is only scored later in the existing
 *     hidden-text recording phase.
 *   - No "full read-through" inside this component. Tapping the CTA
 *     hands control back to the parent (`onContinue`), which kicks off
 *     the existing memorize → hidden-text recording → scoring path.
 *   - Owns its own audio recorder & player so it can fully clean up on
 *     unmount without touching the session-level recorder used during
 *     the scored take.
 *
 * Leave-confirmation works the same way ShadowSentenceFlow handles it:
 * we register as the session's leave interceptor so the parent's
 * beforeRemove listener defers to our confirm-and-collapse flow.
 */
export function RecitePrepFlow({
  text,
  voice: voiceProp,
  accentColor,
  contentType,
  articleId,
  onContinue,
}: Props) {
  const colors = useColors();
  const t = useT();
  const navigation = useNavigation();
  const { userId, settings, updateSettings } = useApp();

  const [voice, setVoice] = useState<string>(voiceProp);
  const [rate, setRateState] = useState<number>(1);
  const player = useAudioPlayer({ articleId, userId });
  const recordingPlayer = useAudioPlayer({ articleId, userId });

  const handleSelectVoice = useCallback(
    (newVoice: string) => {
      setVoice(newVoice);
      player.stop();
      updateSettings({ preferredVoice: newVoice, preferredVoiceUserSet: true });
    },
    [player, updateSettings]
  );
  const handleSelectRate = useCallback(
    (newRate: number) => {
      setRateState(newRate);
      player.setRate(newRate);
    },
    [player]
  );

  const {
    startRecording,
    stopRecording,
    isRecording,
    permission,
    requestPermission,
    openAppSettings,
    lastRecordingUri,
    clearLastRecording,
  } = useAudioRecorder();
  const { requestAccess: requestMicAccess, modal: micPermissionModal } =
    useMicPermissionGate({ permission, requestPermission, openAppSettings });

  const effectiveType: ContentType = useMemo(
    () => contentType ? normalizeContentType(contentType) : detectContentType(text),
    [contentType, text]
  );
  const layout = useMemo(
    () => buildSentenceLayout(text, effectiveType),
    [effectiveType, text]
  );
  const sentences = useMemo(() => flattenSentences(layout), [layout]);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [phase, setPhase] = useState<FlowPhase>("preview");
  const [states, setStates] = useState<SentenceState[]>(() =>
    sentences.map(() => ({ listened: false, recorded: false }))
  );
  const [isPlayingMyRecording, setIsPlayingMyRecording] = useState(false);
  // Counts down from `computeSentenceMemorizeDuration` while the user
  // is in `memorizing`. 0 means "go" — we transition to reciting.
  const [memorizeRemaining, setMemorizeRemaining] = useState(0);
  const memorizeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const statesRef = useRef<SentenceState[]>(states);
  const updateStates = useCallback(
    (updater: (prev: SentenceState[]) => SentenceState[]) => {
      const next = updater(statesRef.current);
      statesRef.current = next;
      setStates(next);
    },
    []
  );

  // Set when the user has confirmed leaving OR when the parent has been
  // handed control via onContinue. Suppresses the leave dialog so the
  // normal navigation/transition runs cleanly.
  const suppressInterceptRef = useRef(false);
  const playGenRef = useRef(0);
  const playbackWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of the current phase so the unmount cleanup (which captures
  // the mount-time closure) can tell whether to release the recorder
  // hardware. Without this, an unmount triggered while the user is mid-
  // recording (e.g. parent navigates away unexpectedly) would leak the
  // mic handle into the next screen — including the stage-2 scored take
  // that runs on the session-level recorder right after `onContinue`.
  const phaseRef = useRef<FlowPhase>("preview");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const clearMemorizeTimer = useCallback(() => {
    if (memorizeTimerRef.current) {
      clearInterval(memorizeTimerRef.current);
      memorizeTimerRef.current = null;
    }
  }, []);

  // Start the per-sentence countdown. Sets phase=memorizing, ticks once
  // a second, and flips to "reciting" when it hits 0. Calling this
  // while already counting clears the previous timer first so callers
  // don't have to coordinate.
  const startMemorizeCountdown = useCallback(
    (idx: number) => {
      clearMemorizeTimer();
      const total = computeSentenceMemorizeDuration(sentences[idx] ?? "");
      setMemorizeRemaining(total);
      setPhase("memorizing");
      memorizeTimerRef.current = setInterval(() => {
        setMemorizeRemaining((n) => {
          if (n <= 1) {
            clearMemorizeTimer();
            setPhase("reciting");
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    },
    [sentences, clearMemorizeTimer]
  );

  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const rowRefs = useRef<Map<number, View | null>>(new Map());

  const clearPlaybackWatchdog = useCallback(() => {
    if (playbackWatchdogRef.current) {
      clearTimeout(playbackWatchdogRef.current);
      playbackWatchdogRef.current = null;
    }
  }, []);

  // Best-effort prefetch so per-sentence playback feels instant.
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

  // Plays sentence `idx`. The `intent` decides what to do when playback
  // ends:
  //   - "auto"  : we're in the preview beat; chain into the memorize
  //               countdown when audio finishes.
  //   - "replay": user explicitly tapped a "listen again" affordance;
  //               do NOT advance the state machine — return them to
  //               the same phase they were in (preview/memorizing/
  //               reviewing) so they can keep doing what they were doing.
  const playSentence = useCallback(
    (idx: number, intent: "auto" | "replay" = "auto") => {
      if (idx >= sentences.length) return;
      clearPlaybackWatchdog();
      // If a memorize countdown is already running for this sentence,
      // pause it while audio plays so the phase doesn't auto-flip to
      // "reciting" mid-playback. We'll restart it when audio ends.
      const wasMemorizing = phaseRef.current === "memorizing";
      if (wasMemorizing) clearMemorizeTimer();
      const gen = ++playGenRef.current;
      const onFinish = () => {
        updateStates((prev) =>
          prev.map((s, i) => (i === idx ? { ...s, listened: true } : s))
        );
        if (intent === "auto" || wasMemorizing) {
          startMemorizeCountdown(idx);
        }
      };
      try {
        player.playTTS(sentences[idx], voice, () => {
          if (gen !== playGenRef.current) return;
          clearPlaybackWatchdog();
          onFinish();
        });
      } catch {
        if (gen === playGenRef.current) {
          onFinish();
        }
        return;
      }
      const estMs = Math.max(8000, Math.min(60000, estimateTtsMs(sentences[idx]) * 2));
      playbackWatchdogRef.current = setTimeout(() => {
        if (gen !== playGenRef.current) return;
        playbackWatchdogRef.current = null;
        onFinish();
      }, estMs);
    },
    [sentences, voice, player, clearPlaybackWatchdog, updateStates, startMemorizeCountdown, clearMemorizeTimer]
  );

  // Mount-time auto-play. The recitation loop is "look/listen → cover
  // → recite", so the first beat is the TTS. We kick it off
  // automatically on mount and again whenever `currentIdx` changes
  // (see `goToSentence`).
  //
  // Cleanup: tear down an in-flight recording on unmount so the mic
  // handle is released before the parent transitions into the scored
  // stage-2 take (which uses the session-level recorder). The hand-off
  // path already calls stopRecording, but unmount triggered by any
  // other path (parent re-render, navigation race, etc.) would
  // otherwise leak the mic. Also clear the per-sentence countdown so
  // it doesn't keep ticking against an unmounted component.
  useEffect(() => {
    if (sentences.length > 0) {
      playSentence(0, "auto");
    }
    return () => {
      clearPlaybackWatchdog();
      clearMemorizeTimer();
      try {
        player.stop();
      } catch {}
      try {
        recordingPlayer.stop();
      } catch {}
      if (phaseRef.current === "reciting") {
        try {
          void stopRecording().catch(() => {});
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── leave-confirmation dialog ─────────────────────────────────────────
  // Same coordination contract as ShadowSentenceFlow: we flag the
  // parent's beforeRemove listener so it only preventDefault()s and
  // hands the collapse animation off to us. On "Discard" we run the
  // close animation (if registered) and dispatch the pop ourselves.
  useEffect(() => {
    setShadowLeaveIntercept(true);
    return () => {
      setShadowLeaveIntercept(false);
    };
  }, []);

  useEffect(() => {
    const sub = navigation.addListener("beforeRemove", (e: unknown) => {
      if (suppressInterceptRef.current) return;
      const event = e as { preventDefault: () => void };
      event.preventDefault();
      Alert.alert(
        t("session.recite.prep.leaveTitle"),
        t("session.recite.prep.leaveBody"),
        [
          { text: t("session.shadow.leaveStay"), style: "cancel" },
          {
            text: t("session.shadow.leaveDiscard"),
            style: "destructive",
            onPress: () => {
              suppressInterceptRef.current = true;
              setShadowLeaveIntercept(false);
              // Tear down any in-progress recording so we don't leak
              // the mic handle after unmount.
              clearMemorizeTimer();
              if (phase === "reciting") {
                try {
                  void stopRecording().catch(() => {});
                } catch {}
              }
              const dispatchPop = () => {
                const nav = navigation as unknown as {
                  dispatch: (action: unknown) => void;
                };
                nav.dispatch({ type: "POP", payload: { count: 1 } });
              };
              const runner = getSessionCloseRunner();
              if (runner) {
                runner(() => {
                  requestAnimationFrame(dispatchPop);
                });
              } else {
                dispatchPop();
              }
            },
          },
        ]
      );
    });
    return sub;
  }, [navigation, phase, stopRecording, t, clearMemorizeTimer]);

  // ── per-sentence loop ─────────────────────────────────────────────────

  // "I'm ready" — bypass the rest of the memorize countdown and jump
  // straight to reciting. Also used implicitly when the mic button is
  // pressed during preview/memorizing.
  const handleSkipToReciting = useCallback(() => {
    clearMemorizeTimer();
    try {
      player.stop();
    } catch {}
    playGenRef.current++;
    clearPlaybackWatchdog();
    setMemorizeRemaining(0);
    setPhase("reciting");
  }, [clearMemorizeTimer, player, clearPlaybackWatchdog]);

  const handleMicPress = useCallback(async () => {
    if (phase === "reciting" && isRecording) {
      // Actively recording → stop, mark recorded, → reviewing.
      await stopRecording().catch(() => null);
      updateStates((prev) =>
        prev.map((s, i) => (i === currentIdx ? { ...s, recorded: true } : s))
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setPhase("reviewing");
      return;
    }
    if (phase === "reciting" && !isRecording) {
      // Mic is armed but not recording yet — start.
      requestMicAccess(async () => {
        const ok = await startRecording();
        if (!ok) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      });
      return;
    }
    // From preview / memorizing the mic press both jumps to "reciting"
    // AND arms the mic in one tap, so the user gets the immediate
    // "go ahead" affordance they'd expect when bailing out of the
    // countdown early.
    if (phase === "preview" || phase === "memorizing") {
      handleSkipToReciting();
      requestMicAccess(async () => {
        const ok = await startRecording();
        if (!ok) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      });
    }
  }, [
    phase,
    isRecording,
    stopRecording,
    startRecording,
    requestMicAccess,
    currentIdx,
    updateStates,
    handleSkipToReciting,
  ]);

  const handleReplayCurrent = useCallback(() => {
    if (phase === "reciting") return;
    playSentence(currentIdx, "replay");
  }, [phase, playSentence, currentIdx]);

  const handlePlayMyRecording = useCallback(() => {
    if (!lastRecordingUri) return;
    if (phase === "reciting") return;
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
      if (phase === "reciting" && isRecording) return;
      try {
        player.stop();
      } catch {}
      try {
        recordingPlayer.stop();
      } catch {}
      clearMemorizeTimer();
      setMemorizeRemaining(0);
      setIsPlayingMyRecording(false);
      clearLastRecording();
      setCurrentIdx(nextIdx);
      setPhase("preview");
      playSentence(nextIdx, "auto");
    },
    [
      sentences.length,
      phase,
      isRecording,
      player,
      recordingPlayer,
      clearLastRecording,
      clearMemorizeTimer,
      playSentence,
    ]
  );

  const handleNext = useCallback(() => {
    goToSentence(currentIdx + 1);
  }, [currentIdx, goToSentence]);

  const handlePrev = useCallback(() => {
    goToSentence(currentIdx - 1);
  }, [currentIdx, goToSentence]);

  const replayAny = useCallback(
    (idx: number) => {
      if (phase === "reciting" && isRecording) return;
      if (idx === currentIdx) {
        playSentence(idx, "replay");
        return;
      }
      goToSentence(idx);
    },
    [phase, isRecording, currentIdx, playSentence, goToSentence]
  );

  // Hand-off to the parent's recitation flow. Tear down audio + mic and
  // release the leave intercept so the parent's normal phase transition
  // (and any subsequent navigation) isn't trapped by our dialog.
  const handStartingOffRef = useRef(false);
  const handleStartFullRecitation = useCallback(async () => {
    // Guard against a double-tap kicking off two transitions while the
    // recorder stop is still settling.
    if (handStartingOffRef.current) return;
    handStartingOffRef.current = true;
    try {
      player.stop();
    } catch {}
    try {
      recordingPlayer.stop();
    } catch {}
    playGenRef.current++;
    clearPlaybackWatchdog();
    suppressInterceptRef.current = true;
    setShadowLeaveIntercept(false);
    clearMemorizeTimer();
    if (phase === "reciting" && isRecording) {
      // Block the hand-off until stopRecording resolves so the next
      // recorder (the scored take on the session-level useAudioRecorder)
      // doesn't race with our mic handle. Capped so a stuck recorder
      // can't strand the user on the prep screen.
      try {
        await Promise.race([
          stopRecording().catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
      } catch {}
    }
    onContinue();
  }, [
    phase,
    isRecording,
    stopRecording,
    player,
    recordingPlayer,
    clearPlaybackWatchdog,
    clearMemorizeTimer,
    onContinue,
  ]);

  // Auto-scroll the current sentence into view. Same approach as
  // ShadowSentenceFlow (measureInWindow-based for Fabric / RN-web).
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

  const meta = CONTENT_TYPE_META[effectiveType];
  const Badge = meta.showBadge ? (
    <View style={[styles.contentTypeBadge, { backgroundColor: accentColor + "18" }]}>
      <Icon name={meta.icon} size={10} color={accentColor} />
      <Text style={[styles.contentTypeBadgeText, { color: accentColor }]}>
        {getContentTypeLabel(effectiveType, settings.nativeLanguage)}
      </Text>
    </View>
  ) : null;

  const replayDisabled = phase === "reciting" && isRecording;

  // The current sentence is replaced with its masked rendering ONLY
  // while the user is reciting from memory. Other beats — preview,
  // memorize-countdown, post-recording review — show the original so
  // the user can read along, memorize, or self-compare.
  const maskedCurrentText = useMemo(() => {
    if (currentIdx >= sentences.length) return "";
    return buildRecitationHintPlan(sentences[currentIdx] ?? "", 0).display;
  }, [sentences, currentIdx]);

  const renderSentenceRow = (globalIdx: number, sent: string) => {
    const st = states[globalIdx];
    const isCurrent = globalIdx === currentIdx;
    const showMasked = isCurrent && phase === "reciting";
    const displayText = showMasked ? maskedCurrentText || sent : sent;
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
          {showMasked ? (
            <EyeOff size={11} color={playColor} />
          ) : (
            <Play size={11} color={playColor} fill={playColor} />
          )}
        </View>
        <Text style={[styles.sentText, { color }, rtlTextStyle(displayText)]}>
          {displayText}
        </Text>
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
    // Empty article — nothing to warm up on. Skip straight to the
    // existing memorize / hidden-text path so the user can still record.
    return (
      <View style={styles.wrap}>
        <TouchableOpacity
          onPress={handleStartFullRecitation}
          style={[styles.fullReadCta, { backgroundColor: accentColor }]}
          activeOpacity={0.85}
        >
          <ArrowRightCircle size={18} color="#fff" />
          <Text style={styles.fullReadCtaText}>
            {t("session.recite.prep.startFull")}
          </Text>
        </TouchableOpacity>
        {micPermissionModal}
      </View>
    );
  }

  let loopHint: string;
  if (phase === "preview") {
    loopHint = t("session.recite.prep.previewHint");
  } else if (phase === "memorizing") {
    loopHint = t("session.recite.prep.memorizeHint");
  } else if (phase === "reciting") {
    loopHint = isRecording
      ? t("session.recite.prep.recordingHint")
      : t("session.recite.prep.reciteHint");
  } else {
    loopHint = t("session.recite.prep.reviewHint");
  }
  const isLast = currentIdx >= sentences.length - 1;
  // The mic button is the focal action only once we've reached the
  // reciting beat — earlier beats have their own affordances (auto-play
  // during preview, "I'm ready" during memorizing) so the mic stays
  // disabled there to keep the call-to-action obvious.
  const micDisabled = phase === "preview";

  const renderControls = () => (
    <View style={styles.controls}>
      <View style={styles.voiceSection}>
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
          {t("sentence.voice")}
        </Text>
        <View style={styles.voiceGrid}>
          {VOICE_OPTIONS.map((opt) => {
            const active = voice === opt.id;
            const genderLabel =
              opt.gender === "female" ? "♀" : opt.gender === "male" ? "♂" : "·";
            return (
              <TouchableOpacity
                key={opt.id}
                onPress={() => handleSelectVoice(opt.id)}
                activeOpacity={0.85}
                style={[
                  styles.voiceChip,
                  {
                    backgroundColor: active ? accentColor : colors.muted,
                    borderColor: active ? accentColor : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.voiceChipGender,
                    { color: active ? "#fff" : colors.mutedForeground },
                  ]}
                >
                  {genderLabel}
                </Text>
                <View style={styles.voiceChipTextWrap}>
                  <Text
                    style={[
                      styles.voiceChipName,
                      { color: active ? "#fff" : colors.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.voiceChipDesc,
                      {
                        color: active ? "rgba(255,255,255,0.85)" : colors.mutedForeground,
                      },
                    ]}
                  >
                    {opt.description}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={[styles.speedRow, { backgroundColor: colors.muted }]}>
        <Text style={[styles.speedLabel, { color: colors.mutedForeground }]}>
          {t("sentence.speed")}
        </Text>
        {SPEED_OPTIONS.map((opt) => {
          const active = rate === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              onPress={() => handleSelectRate(opt.value)}
              activeOpacity={0.8}
              style={[
                styles.speedBtn,
                active && { backgroundColor: accentColor },
              ]}
            >
              <Text
                style={[
                  styles.speedBtnText,
                  { color: active ? "#fff" : colors.foreground },
                ]}
              >
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.prepIntroCard,
          { backgroundColor: accentColor + "12", borderColor: accentColor + "44" },
        ]}
      >
        <Headphones size={18} color={accentColor} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.prepIntroTitle, { color: accentColor }]}>
            {t("session.recite.prep.title")}
          </Text>
          <Text style={[styles.prepIntroBody, { color: colors.foreground }]}>
            {t("session.recite.prep.sub")}
          </Text>
        </View>
      </View>

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

      {renderControls()}

      <View style={styles.recordSection}>
        {phase === "memorizing" ? (
          <View
            style={[
              styles.countdownChip,
              {
                backgroundColor: accentColor + "15",
                borderColor: accentColor + "55",
              },
            ]}
          >
            <Timer size={16} color={accentColor} />
            <Text style={[styles.countdownChipNum, { color: accentColor }]}>
              {memorizeRemaining}
            </Text>
            <Text
              style={[styles.countdownChipLabel, { color: colors.mutedForeground }]}
            >
              {t("session.recite.prep.countdownLabel")}
            </Text>
          </View>
        ) : null}

        <TouchableOpacity
          onPress={handleMicPress}
          disabled={micDisabled}
          style={[
            styles.recordBtn,
            {
              backgroundColor: isRecording ? "#EF4444" : accentColor,
              shadowColor: isRecording ? "#EF4444" : accentColor,
              opacity: micDisabled ? 0.45 : 1,
            },
          ]}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={loopHint}
        >
          <Icon name={isRecording ? "square" : "mic"} size={32} color="#fff" />
        </TouchableOpacity>
        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>{loopHint}</Text>
        {isRecording ? <AudioWaveform isActive color="#EF4444" /> : null}

        {phase === "memorizing" ? (
          <TouchableOpacity
            onPress={handleSkipToReciting}
            style={[
              styles.readyBtn,
              { backgroundColor: accentColor + "1A", borderColor: accentColor },
            ]}
            activeOpacity={0.85}
            accessibilityRole="button"
          >
            <Text style={[styles.readyBtnText, { color: accentColor }]}>
              {t("session.recite.prep.readyNow")}
            </Text>
          </TouchableOpacity>
        ) : null}

        {!isRecording ? (
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
            {phase === "reviewing" && lastRecordingUri ? (
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

      {/* Always-tappable CTA — same rationale as ShadowSentenceFlow's
          "Read the full passage": the per-sentence loop is warm-up
          only, and the user should be free to jump to the scored take
          whenever they feel ready. The handler tears down any in-flight
          recording / playback before transitioning so the mic is
          released cleanly. */}
      <TouchableOpacity
        onPress={handleStartFullRecitation}
        style={[styles.fullReadCta, { backgroundColor: accentColor }]}
        activeOpacity={0.85}
      >
        <ArrowRightCircle size={18} color="#fff" />
        <Text style={styles.fullReadCtaText}>
          {t("session.recite.prep.startFull")}
        </Text>
      </TouchableOpacity>

      {micPermissionModal}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  prepIntroCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  prepIntroTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    marginBottom: 2,
  },
  prepIntroBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
  },
  controls: { gap: 10 },
  voiceSection: { gap: 6 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    paddingHorizontal: 2,
  },
  voiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    flexBasis: "32%",
    flexGrow: 1,
    minWidth: 0,
  },
  voiceChipGender: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    width: 12,
    textAlign: "center",
  },
  voiceChipTextWrap: { flex: 1, minWidth: 0 },
  voiceChipName: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  voiceChipDesc: { fontSize: 10, fontFamily: "Inter_400Regular", marginTop: 1 },
  speedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    alignSelf: "center",
  },
  speedLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginRight: 4 },
  speedBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    minWidth: 44,
    alignItems: "center",
  },
  speedBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
  progressBarFill: { height: "100%", borderRadius: 2 },
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
  paragraphBlock: { marginBottom: 6 },
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
  speakerText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
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
  progressText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  replayBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  replayBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
  optBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  countdownChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  countdownChipNum: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    minWidth: 22,
    textAlign: "center",
  },
  countdownChipLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  readyBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  readyBtnText: {
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
});
