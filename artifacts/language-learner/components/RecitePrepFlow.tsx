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
  Headphones,
  Play,
  Square,
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
import { CONTENT_TYPE_META, detectContentType } from "@/utils/contentType";
import { buildSentenceLayout, flattenSentences } from "@/utils/sentences";
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

type FlowPhase = "ready" | "playing" | "recording";

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

  const [currentIdx, setCurrentIdx] = useState(0);
  const [phase, setPhase] = useState<FlowPhase>("ready");
  const [states, setStates] = useState<SentenceState[]>(() =>
    sentences.map(() => ({ listened: false, recorded: false }))
  );
  const [isPlayingMyRecording, setIsPlayingMyRecording] = useState(false);

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
  const phaseRef = useRef<FlowPhase>("ready");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

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

  // Mount-time cleanup. We intentionally do NOT auto-play the first
  // sentence — same rationale as ShadowSentenceFlow.
  //
  // Important: also tear down an in-flight recording on unmount so the
  // mic handle is released before the parent transitions into the
  // scored stage-2 take (which uses the session-level recorder). The
  // hand-off path already calls stopRecording, but unmount triggered by
  // any other path (parent re-render, navigation race, etc.) would
  // otherwise leak the mic.
  useEffect(() => {
    return () => {
      clearPlaybackWatchdog();
      try {
        player.stop();
      } catch {}
      try {
        recordingPlayer.stop();
      } catch {}
      if (phaseRef.current === "recording") {
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
              if (phase === "recording") {
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
  }, [navigation, phase, stopRecording, t]);

  // ── per-sentence loop ─────────────────────────────────────────────────

  const handleMicPress = useCallback(async () => {
    if (phase === "recording") {
      await stopRecording();
      setPhase("ready");
      updateStates((prev) =>
        prev.map((s, i) => (i === currentIdx ? { ...s, recorded: true } : s))
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    }
    if (phase === "ready" || phase === "playing") {
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
    if (phase === "recording") {
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
    stopRecording,
    player,
    recordingPlayer,
    clearPlaybackWatchdog,
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

  const loopHint =
    phase === "recording"
      ? t("session.shadow.stopHint")
      : t("session.recite.prep.guidedHint");
  const isLast = currentIdx >= sentences.length - 1;

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
