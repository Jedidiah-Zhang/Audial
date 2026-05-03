import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
} from "react-native";
import { ArrowRight, Check, RefreshCw, SkipForward, Volume2, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioPlayer } from "@/hooks/useAudio";
import { useT } from "@/utils/i18n";
import { rtlTextStyle } from "@/utils/rtl";
import { getDefaultVoiceForLanguage } from "@/utils/voiceForLanguage";
import type { VocabularyItem } from "@/types";

interface Props {
  vocabulary: VocabularyItem[];
  targetLanguage: string;
  articleId: string;
  accentColor: string;
  onComplete: () => void;
  onSkipAll: () => void;
}

type ItemStatus = "idle" | "correct" | "wrong";

/**
 * Normalize a word for case-insensitive, punctuation-tolerant comparison.
 * We lowercase + NFC and strip surrounding whitespace plus a small set of
 * punctuation characters. Internal punctuation (e.g. apostrophes inside
 * "don't") is preserved so it must still match.
 */
function normalize(s: string): string {
  return s
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

export function VocabularyDictationFlow({
  vocabulary,
  targetLanguage,
  articleId,
  accentColor,
  onComplete,
  onSkipAll,
}: Props) {
  const colors = useColors();
  const t = useT();
  const { settings, userId } = useApp();
  const { playTTS, stop } = useAudioPlayer({ articleId, userId });

  const voice =
    (settings.preferredVoiceUserSet
      ? settings.preferredVoice
      : getDefaultVoiceForLanguage(targetLanguage) ?? settings.preferredVoice) ??
    "nova";

  const items = useMemo(
    () => vocabulary.filter((v) => v.word && v.word.trim().length > 0),
    [vocabulary]
  );

  const [currentIdx, setCurrentIdx] = useState(0);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ItemStatus>("idle");
  const [correctCount, setCorrectCount] = useState(0);
  const [completed, setCompleted] = useState(false);

  const total = items.length;
  const current = items[currentIdx];

  const playCurrent = useCallback(
    (word: string) => {
      void playTTS(word, voice, undefined, 0.9);
    },
    [playTTS, voice]
  );

  // Auto-play the current word when it changes (and on mount).
  const lastPlayedIdxRef = useRef<number>(-1);
  useEffect(() => {
    if (completed) return;
    if (!current) return;
    if (lastPlayedIdxRef.current === currentIdx) return;
    lastPlayedIdxRef.current = currentIdx;
    playCurrent(current.word);
  }, [currentIdx, current, completed, playCurrent]);

  useEffect(() => {
    return () => {
      try {
        stop();
      } catch {
        /* ignore */
      }
    };
  }, [stop]);

  const advance = useCallback(() => {
    setInput("");
    setStatus("idle");
    if (currentIdx + 1 >= total) {
      setCompleted(true);
      try {
        stop();
      } catch {
        /* ignore */
      }
    } else {
      setCurrentIdx((i) => i + 1);
    }
  }, [currentIdx, total, stop]);

  const handleSubmit = () => {
    if (!current || status !== "idle") return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const ok = normalize(trimmed) === normalize(current.word);
    if (ok) {
      setCorrectCount((n) => n + 1);
      setStatus("correct");
    } else {
      setStatus("wrong");
    }
  };

  const handleReplay = () => {
    if (!current) return;
    playCurrent(current.word);
  };

  const handleSkip = () => {
    // Skip counts as not-correct. Move on without revealing the answer
    // — keeps the flow snappy when the user just doesn't know the word.
    advance();
  };

  const handleNext = () => {
    advance();
  };

  if (total === 0) {
    // Defensive: parent should have skipped the sub-stage entirely when
    // there's no vocabulary, but render a simple continue card just in
    // case so the flow can never get stuck here.
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {t("vocabDictation.title")}
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {t("vocabDictation.empty")}
        </Text>
        <TouchableOpacity
          onPress={onComplete}
          style={[styles.primaryBtn, { backgroundColor: accentColor }]}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>{t("vocabDictation.continue")}</Text>
          <ArrowRight size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  if (completed) {
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View
          style={[
            styles.summaryBadge,
            { backgroundColor: accentColor + "20" },
          ]}
        >
          <Check size={32} color={accentColor} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {t("vocabDictation.summary.title")}
        </Text>
        <Text style={[styles.summaryScore, { color: accentColor }]}>
          {t("vocabDictation.summary.score", { correct: correctCount, total })}
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {t("vocabDictation.summary.body")}
        </Text>
        <TouchableOpacity
          onPress={onComplete}
          style={[styles.primaryBtn, { backgroundColor: accentColor }]}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>{t("vocabDictation.continue")}</Text>
          <ArrowRight size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  const isCorrect = status === "correct";
  const isWrong = status === "wrong";
  const showFeedback = isCorrect || isWrong;
  const borderColor = isCorrect
    ? "#10B981"
    : isWrong
    ? "#EF4444"
    : accentColor;

  return (
    <View style={{ gap: 14 }}>
      <View style={[styles.headerRow]}>
        <Text style={[styles.progress, { color: colors.mutedForeground }]}>
          {t("vocabDictation.progress", { i: currentIdx + 1, n: total })}
        </Text>
        <TouchableOpacity onPress={onSkipAll} activeOpacity={0.7} style={styles.skipAllBtn}>
          <Text style={[styles.skipAllText, { color: colors.mutedForeground }]}>
            {t("vocabDictation.skipAll")}
          </Text>
        </TouchableOpacity>
      </View>

      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.card,
            borderColor,
            borderWidth: showFeedback ? 2 : 1,
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground }]}>
          {t("vocabDictation.title")}
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {t("vocabDictation.subtitle")}
        </Text>

        <TouchableOpacity
          onPress={handleReplay}
          style={[
            styles.playBtn,
            { backgroundColor: accentColor + "1A", borderColor: accentColor + "55" },
          ]}
          activeOpacity={0.8}
        >
          <Volume2 size={28} color={accentColor} />
          <Text style={[styles.playBtnText, { color: accentColor }]}>
            {t("vocabDictation.replay")}
          </Text>
        </TouchableOpacity>

        <TextInput
          style={[
            styles.input,
            {
              color: colors.foreground,
              borderColor: showFeedback ? borderColor : colors.border,
              backgroundColor: colors.muted,
            },
            rtlTextStyle(input || current.word),
          ]}
          value={input}
          onChangeText={(v) => {
            if (status !== "idle") return;
            setInput(v);
          }}
          placeholder={t("vocabDictation.placeholder")}
          placeholderTextColor={colors.mutedForeground}
          autoCorrect={false}
          autoCapitalize="none"
          editable={status === "idle"}
          onSubmitEditing={handleSubmit}
          returnKeyType="done"
        />

        {showFeedback && (
          <View
            style={[
              styles.feedbackBox,
              {
                backgroundColor: (isCorrect ? "#10B981" : "#EF4444") + "15",
              },
            ]}
          >
            <View style={styles.feedbackHeader}>
              {isCorrect ? (
                <Check size={16} color="#10B981" />
              ) : (
                <X size={16} color="#EF4444" />
              )}
              <Text
                style={[
                  styles.feedbackTitle,
                  { color: isCorrect ? "#10B981" : "#EF4444" },
                ]}
              >
                {isCorrect ? t("vocabDictation.correct") : t("vocabDictation.wrong")}
              </Text>
            </View>
            {!isCorrect && (
              <Text style={[styles.answerLine, { color: colors.foreground }, rtlTextStyle(current.word)]}>
                <Text style={[styles.answerLabel, { color: colors.mutedForeground }]}>
                  {t("vocabDictation.correctAnswer")}{" "}
                </Text>
                {current.word}
              </Text>
            )}
            {current.meaning ? (
              <Text style={[styles.meaningLine, { color: colors.mutedForeground }, rtlTextStyle(current.meaning)]}>
                {current.meaning}
              </Text>
            ) : null}
          </View>
        )}

        {status === "idle" ? (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              onPress={handleSkip}
              activeOpacity={0.8}
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
            >
              <SkipForward size={16} color={colors.mutedForeground} />
              <Text style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}>
                {t("vocabDictation.skip")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!input.trim()}
              activeOpacity={0.85}
              style={[
                styles.primaryBtn,
                {
                  backgroundColor: accentColor,
                  opacity: input.trim() ? 1 : 0.4,
                  flex: 1,
                },
              ]}
            >
              <Check size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>{t("vocabDictation.submit")}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.actionsRow}>
            <TouchableOpacity
              onPress={handleReplay}
              activeOpacity={0.8}
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
            >
              <RefreshCw size={16} color={colors.mutedForeground} />
              <Text style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}>
                {t("vocabDictation.replay")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleNext}
              activeOpacity={0.85}
              style={[styles.primaryBtn, { backgroundColor: accentColor, flex: 1 }]}
            >
              <Text style={styles.primaryBtnText}>
                {currentIdx + 1 >= total
                  ? t("vocabDictation.finish")
                  : t("vocabDictation.next")}
              </Text>
              <ArrowRight size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  progress: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  skipAllBtn: { paddingVertical: 4, paddingHorizontal: 6 },
  skipAllText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 18,
    gap: 12,
    alignItems: "stretch",
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 19,
  },
  playBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 4,
  },
  playBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  input: {
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 14 : 10,
    fontSize: 17,
    fontFamily: "Inter_500Medium",
  },
  feedbackBox: {
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  feedbackHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  feedbackTitle: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  answerLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  answerLine: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  meaningLine: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  summaryBadge: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  summaryScore: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
});
