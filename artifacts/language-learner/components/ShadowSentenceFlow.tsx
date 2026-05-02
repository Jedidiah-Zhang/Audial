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
  findNodeHandle,
} from "react-native";
import { Check, Play, RotateCcw, SkipForward, Volume2, X } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioPlayer, useAudioRecorder, transcribeAudio, prefetchTTS } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";
import { Icon } from "@/components/Icon";
import { useT } from "@/utils/i18n";
import type { ContentType } from "@/types";
import { STAGE_PASS_SCORE } from "@/types";
import { CONTENT_TYPE_META, detectContentType } from "@/utils/contentType";
import { buildSentenceLayout, flattenSentences } from "@/utils/sentences";
import { getContentTypeLabel } from "@/utils/i18n";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export interface PerSentenceResult {
  index: number;
  score: number;
  passed: boolean;
  transcript: string;
  target: string;
  feedback?: string;
  mistakes?: string[];
}

export interface ShadowFlowResult {
  score: number;
  feedback: string;
  perSentence: PerSentenceResult[];
}

type SentenceStatus = "pending" | "passed" | "failed";

interface SentenceState {
  status: SentenceStatus;
  score?: number;
  transcript?: string;
  feedback?: string;
  mistakes?: string[];
}

type FlowPhase =
  | "playing"
  | "ready"
  | "recording"
  | "transcribing"
  | "scoring"
  | "passed-pause"
  | "failed-options"
  | "done";

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
  const { userId, settings } = useApp();
  const player = useAudioPlayer({ articleId, userId });
  const { startRecording, stopRecording, isRecording } = useAudioRecorder();

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
  const [phase, setPhase] = useState<FlowPhase>("playing");
  const [states, setStates] = useState<SentenceState[]>(() =>
    sentences.map(() => ({ status: "pending" as SentenceStatus }))
  );

  // Source-of-truth mirror of `states` so completion paths can synchronously
  // read the freshest values without depending on React's update timing.
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
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playGenRef = useRef(0);

  // Refs for per-sentence auto-scroll. We measure each row against the
  // ScrollView's inner content view so nested layouts (dialogue bubbles)
  // resolve to the correct global y.
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const rowRefs = useRef<Map<number, View | null>>(new Map());

  const stopAdvanceTimer = useCallback(() => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
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
      stopAdvanceTimer();
      const gen = ++playGenRef.current;
      setPhase("playing");
      player.playTTS(sentences[idx], voice, () => {
        // Ignore stale callbacks (user moved on / restarted playback).
        if (gen !== playGenRef.current) return;
        setPhase("ready");
      });
    },
    [sentences, voice, player, stopAdvanceTimer]
  );

  // Kick off the very first sentence on mount.
  useEffect(() => {
    if (sentences.length === 0) {
      // Empty article — nothing to do; report a perfect score so the result
      // page doesn't get stuck in a bad state.
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete({ score: 0, feedback: "", perSentence: [] });
      }
      return;
    }
    playSentence(0);
    return () => {
      stopAdvanceTimer();
      player.stop();
    };
    // Intentionally only run on mount — playSentence captures the latest
    // sentence array via closure, and re-running this effect would restart
    // playback every time state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishFlow = useCallback(
    (finalStates: SentenceState[]) => {
      if (completedRef.current) return;
      completedRef.current = true;
      stopAdvanceTimer();
      player.stop();

      const perSentence: PerSentenceResult[] = finalStates.map((st, i) => ({
        index: i,
        score: st.score ?? 0,
        passed: st.status === "passed",
        transcript: st.transcript ?? "",
        target: sentences[i] ?? "",
        feedback: st.feedback,
        mistakes: st.mistakes,
      }));

      // Strict mean across ALL sentences. Skipped / unattempted count as 0
      // so they correctly drag the average down.
      const denom = perSentence.length || 1;
      const avg =
        perSentence.reduce((s, p) => s + (p.score ?? 0), 0) / denom;
      const score = Math.round(avg);

      const feedbackParts: string[] = [];
      perSentence.forEach((p) => {
        if (!p.feedback) return;
        if (p.passed && (p.score ?? 0) >= 90) return;
        feedbackParts.push(
          `${t("session.shadow.sentenceProgress", { i: p.index + 1, n: perSentence.length })}: ${p.feedback}`
        );
      });
      const feedback = feedbackParts.slice(0, 4).join("  ");

      onComplete({ score, feedback, perSentence });
    },
    [onComplete, sentences, t, stopAdvanceTimer, player]
  );

  const advanceTo = useCallback(
    (nextIdx: number) => {
      stopAdvanceTimer();
      if (nextIdx >= sentences.length) {
        setPhase("done");
        finishFlow(statesRef.current);
        return;
      }
      setCurrentIdx(nextIdx);
      playSentence(nextIdx);
    },
    [sentences.length, playSentence, finishFlow, stopAdvanceTimer]
  );

  const scoreCurrent = useCallback(
    async (transcript: string) => {
      const idx = currentIdx;
      const target = sentences[idx];
      setPhase("scoring");
      try {
        const response = await fetch(`${BASE_URL}/api/language/score-pronunciation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetText: target,
            transcribedText: transcript,
            language,
          }),
        });
        const json = (await response.json()) as { success: boolean; data: any };
        if (!json.success) throw new Error("Scoring failed");
        const d = json.data;
        const score: number = typeof d.score === "number" ? d.score : 0;
        const passed = score >= STAGE_PASS_SCORE;
        const newState: SentenceState = {
          status: passed ? "passed" : "failed",
          score,
          transcript,
          feedback: typeof d.feedback === "string" ? d.feedback : undefined,
          mistakes: Array.isArray(d.mistakes) ? d.mistakes.slice(0, 6) : undefined,
        };
        updateStates((prev) => prev.map((s, i) => (i === idx ? newState : s)));
        Haptics.notificationAsync(
          passed
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning
        );
        if (passed) {
          setPhase("passed-pause");
          // Brief celebration pause, then advance + auto-play the next sentence.
          advanceTimerRef.current = setTimeout(() => {
            const next = idx + 1;
            if (next >= sentences.length) {
              finishFlow(statesRef.current);
            } else {
              advanceTo(next);
            }
          }, 1100);
        } else {
          setPhase("failed-options");
        }
      } catch {
        Alert.alert(t("common.error"), t("session.alert.scoreFailed"));
        setPhase("ready");
      }
    },
    [currentIdx, sentences, language, t, advanceTo, finishFlow]
  );

  const handleMicPress = useCallback(async () => {
    if (phase === "playing") {
      // Allow user to interrupt playback and start recording immediately.
      player.stop();
      playGenRef.current++;
      setPhase("ready");
      return;
    }
    if (phase === "recording") {
      setPhase("transcribing");
      const blob = await stopRecording();
      if (!blob) {
        setPhase("ready");
        return;
      }
      try {
        const transcript = await transcribeAudio(blob);
        if (!transcript || !transcript.trim()) {
          Alert.alert(t("common.tip"), t("session.alert.transcribeFailed"));
          setPhase("ready");
          return;
        }
        await scoreCurrent(transcript.trim());
      } catch {
        Alert.alert(t("common.error"), t("session.alert.transcribeFailed"));
        setPhase("ready");
      }
      return;
    }
    if (phase === "ready" || phase === "failed-options") {
      // Force-stop any TTS / ambient before recording.
      player.stop();
      playGenRef.current++;
      const ok = await startRecording();
      if (!ok) {
        Alert.alert(t("common.tip"), t("session.alert.micPermission"));
        return;
      }
      setPhase("recording");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  }, [phase, player, stopRecording, startRecording, scoreCurrent, t]);

  const handleReplayCurrent = useCallback(() => {
    if (phase === "recording" || phase === "transcribing" || phase === "scoring") return;
    playSentence(currentIdx);
  }, [phase, playSentence, currentIdx]);

  // Replay any sentence (current or not). For a non-current sentence we play
  // a one-shot TTS that does NOT mutate the flow phase, so users can review
  // earlier passed sentences without disturbing where they are.
  const replayAny = useCallback(
    (idx: number) => {
      if (
        phase === "recording" ||
        phase === "transcribing" ||
        phase === "scoring" ||
        phase === "passed-pause"
      )
        return;
      if (idx === currentIdx) {
        playSentence(idx);
        return;
      }
      // Invalidate any stale "playing" callback so it doesn't bump phase.
      playGenRef.current++;
      player.stop();
      player.playTTS(sentences[idx], voice);
    },
    [phase, currentIdx, playSentence, player, sentences, voice]
  );

  // Auto-scroll the current sentence into view whenever currentIdx changes.
  useEffect(() => {
    const row = rowRefs.current.get(currentIdx);
    const sv = scrollRef.current;
    const content = contentRef.current;
    if (!row || !sv || !content) return;
    const contentHandle = findNodeHandle(content);
    if (contentHandle == null) return;
    // Defer one frame so layout has settled after state changes.
    const tid = setTimeout(() => {
      try {
        row.measureLayout(
          contentHandle,
          (_x, y) => {
            sv.scrollTo({ y: Math.max(0, y - 24), animated: true });
          },
          () => {}
        );
      } catch {
        /* swallow — best-effort */
      }
    }, 50);
    return () => clearTimeout(tid);
  }, [currentIdx]);

  const handleSkip = useCallback(() => {
    stopAdvanceTimer();
    updateStates((prev) =>
      prev.map((s, i) =>
        i === currentIdx
          ? { ...s, status: "failed" as SentenceStatus, score: s.score ?? 0 }
          : s
      )
    );
    const next = currentIdx + 1;
    if (next >= sentences.length) {
      finishFlow(statesRef.current);
    } else {
      advanceTo(next);
    }
  }, [currentIdx, sentences.length, advanceTo, finishFlow, stopAdvanceTimer, updateStates]);

  const handleRetryCurrent = useCallback(() => {
    updateStates((prev) =>
      prev.map((s, i) =>
        i === currentIdx ? { status: "pending" as SentenceStatus } : s
      )
    );
    setPhase("ready");
  }, [currentIdx, updateStates]);

  // ── rendering helpers ─────────────────────────────────────────────────
  const isProcessing = phase === "transcribing" || phase === "scoring";
  const showFailedOptions = phase === "failed-options";
  const isPassedPause = phase === "passed-pause";

  const meta = CONTENT_TYPE_META[effectiveType];
  const Badge = meta.showBadge ? (
    <View style={[styles.contentTypeBadge, { backgroundColor: accentColor + "18" }]}>
      <Icon name={meta.icon as any} size={10} color={accentColor} />
      <Text style={[styles.contentTypeBadgeText, { color: accentColor }]}>
        {getContentTypeLabel(effectiveType, settings.nativeLanguage)}
      </Text>
    </View>
  ) : null;

  const replayDisabled =
    phase === "recording" ||
    phase === "transcribing" ||
    phase === "scoring" ||
    phase === "passed-pause";

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
    } else if (st.status === "passed") {
      bg = "#10B98112";
    } else if (st.status === "failed") {
      bg = "#EF444412";
    } else {
      opacity = 0.55;
    }
    const iconColor = isCurrent
      ? accentColor
      : st.status === "passed"
      ? "#10B981"
      : st.status === "failed"
      ? "#EF4444"
      : colors.mutedForeground;
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
            { backgroundColor: iconColor + "1A", borderColor: iconColor + "33" },
          ]}
        >
          {st.status === "passed" ? (
            <Check size={12} color={iconColor} />
          ) : st.status === "failed" ? (
            <X size={12} color={iconColor} />
          ) : (
            <Play size={11} color={iconColor} fill={iconColor} />
          )}
        </View>
        <Text style={[styles.sentText, { color }]}>{sent}</Text>
        {st.score != null && (st.status === "passed" || st.status === "failed") ? (
          <Text
            style={[
              styles.inlineScore,
              { color: st.status === "passed" ? "#10B981" : "#EF4444" },
            ]}
          >
            {st.score}
          </Text>
        ) : null}
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

  const hint = (() => {
    if (isProcessing) {
      return phase === "transcribing"
        ? t("session.processing.transcribing")
        : t("session.processing.scoring");
    }
    if (isPassedPause) return t("session.shadow.sentencePassed");
    if (showFailedOptions) return t("session.shadow.sentenceFailed");
    if (phase === "recording") return t("session.shadow.stopHint");
    if (phase === "playing") return t("session.shadow.guidedHint");
    return t("session.shadow.guidedHint");
  })();

  const micBg =
    phase === "recording"
      ? "#EF4444"
      : isPassedPause
      ? "#10B981"
      : showFailedOptions
      ? "#EF4444"
      : accentColor;

  const micIcon = phase === "recording" ? "square" : isPassedPause ? "check" : "mic";
  const micDisabled = isProcessing || isPassedPause || phase === "done";

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
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
        </View>
      </View>

      <View style={styles.recordSection}>
        {isProcessing ? (
          <ActivityIndicator size="large" color={accentColor} />
        ) : (
          <TouchableOpacity
            onPress={handleMicPress}
            disabled={micDisabled}
            style={[
              styles.recordBtn,
              {
                backgroundColor: micBg,
                shadowColor: micBg,
                opacity: micDisabled && !isPassedPause ? 0.6 : 1,
              },
            ]}
            activeOpacity={0.85}
          >
            <Icon name={micIcon as any} size={32} color="#fff" />
          </TouchableOpacity>
        )}
        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>{hint}</Text>
        {phase === "recording" ? <AudioWaveform isActive color="#EF4444" /> : null}

        {showFailedOptions ? (
          <View style={styles.optionRow}>
            <TouchableOpacity
              onPress={handleReplayCurrent}
              style={[styles.optBtn, { borderColor: colors.border }]}
              activeOpacity={0.85}
            >
              <Volume2 size={16} color={colors.foreground} />
              <Text style={[styles.optBtnText, { color: colors.foreground }]}>
                {t("session.shadow.replayThis")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleRetryCurrent}
              style={[styles.optBtn, { borderColor: accentColor, backgroundColor: accentColor + "15" }]}
              activeOpacity={0.85}
            >
              <RotateCcw size={16} color={accentColor} />
              <Text style={[styles.optBtnText, { color: accentColor }]}>
                {t("session.shadow.retryThis")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSkip}
              style={[styles.optBtn, { borderColor: colors.border }]}
              activeOpacity={0.85}
            >
              <SkipForward size={16} color={colors.mutedForeground} />
              <Text style={[styles.optBtnText, { color: colors.mutedForeground }]}>
                {t("session.shadow.skip")}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {isPassedPause ? (
          <View style={styles.passedBadge}>
            <Check size={14} color="#10B981" />
            <Text style={[styles.passedBadgeText, { color: "#10B981" }]}>
              {states[currentIdx]?.score ?? 0}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 16 },
  textCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    maxHeight: 380,
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
  inlineScore: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    marginLeft: 6,
    marginTop: 4,
    minWidth: 22,
    textAlign: "right",
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
  passedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#10B98115",
  },
  passedBadgeText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
});
