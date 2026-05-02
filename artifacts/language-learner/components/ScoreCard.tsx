import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Check, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT, getModeLabel } from "@/utils/i18n";
import { useApp } from "@/context/AppContext";

export interface PerSentenceRow {
  index: number;
  score: number;
  passed: boolean;
  target: string;
  transcript?: string;
}

interface ScoreCardProps {
  score: number;
  feedback: string;
  details?: Record<string, string | number>;
  mode: "shadowing" | "dictation" | "recitation";
  perSentence?: PerSentenceRow[];
}

export function ScoreCard({ score, feedback, details, mode, perSentence }: ScoreCardProps) {
  const colors = useColors();
  const t = useT();
  const { settings } = useApp();
  const lang = settings.nativeLanguage;

  const getScoreColor = () => {
    if (score >= 90) return colors.success;
    if (score >= 70) return colors.warning;
    return colors.destructive;
  };

  const getScoreEmoji = () => {
    if (score >= 90) return t("score.excellent");
    if (score >= 80) return t("score.good");
    if (score >= 70) return t("score.fair");
    if (score >= 60) return t("score.keep_going");
    return t("score.keep_trying");
  };

  const modeLabel = t("score.modeLabel", { mode: getModeLabel(mode, lang) });

  const total = perSentence?.length ?? 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.modeLabel, { color: colors.mutedForeground }]}>{modeLabel}</Text>

      <View style={[styles.scoreCircle, { borderColor: getScoreColor() }]}>
        <Text style={[styles.scoreText, { color: getScoreColor() }]}>{score}</Text>
        <Text style={[styles.scoreMax, { color: colors.mutedForeground }]}>/100</Text>
      </View>

      <Text style={[styles.scoreLabel, { color: getScoreColor() }]}>{getScoreEmoji()}</Text>

      <View style={[styles.bar, { backgroundColor: colors.muted }]}>
        <View
          style={[
            styles.barFill,
            { width: `${score}%` as any, backgroundColor: getScoreColor() },
          ]}
        />
      </View>

      {feedback ? (
        <Text style={[styles.feedback, { color: colors.foreground }]}>{feedback}</Text>
      ) : null}

      {details && Object.keys(details).length > 0 && (
        <View style={styles.details}>
          {Object.entries(details).map(([k, v]) => (
            <View key={k} style={[styles.detailRow, { borderTopColor: colors.border }]}>
              <Text style={[styles.detailKey, { color: colors.mutedForeground }]}>{k}</Text>
              <Text style={[styles.detailVal, { color: colors.foreground }]}>{String(v)}</Text>
            </View>
          ))}
        </View>
      )}

      {perSentence && perSentence.length > 0 && (
        <View style={styles.perSection}>
          <Text style={[styles.perTitle, { color: colors.mutedForeground }]}>
            {t("session.detail.perSentence")}
          </Text>
          {perSentence.map((p) => {
            const tone = p.passed ? "#10B981" : "#EF4444";
            const preview = p.target.length > 36 ? p.target.slice(0, 36) + "…" : p.target;
            return (
              <View
                key={p.index}
                style={[styles.perRow, { borderTopColor: colors.border }]}
              >
                <View style={[styles.perBadge, { backgroundColor: tone + "1A" }]}>
                  {p.passed ? (
                    <Check size={12} color={tone} />
                  ) : (
                    <X size={12} color={tone} />
                  )}
                </View>
                <View style={styles.perTextWrap}>
                  <Text
                    style={[styles.perIndex, { color: colors.mutedForeground }]}
                  >
                    {t("session.shadow.sentenceProgress", {
                      i: p.index + 1,
                      n: total,
                    })}
                  </Text>
                  <Text
                    style={[styles.perTarget, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {preview}
                  </Text>
                </View>
                <Text style={[styles.perScore, { color: tone }]}>{p.score}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    gap: 12,
  },
  modeLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  scoreCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 4,
    flexDirection: "row",
    alignItems: "baseline" as any,
    justifyContent: "center",
  },
  scoreText: {
    fontSize: 48,
    fontFamily: "Inter_700Bold",
    lineHeight: 56,
  },
  scoreMax: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    marginBottom: 4,
  },
  scoreLabel: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  bar: {
    width: "100%",
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
  },
  feedback: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    textAlign: "center",
  },
  details: {
    width: "100%",
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
  },
  detailKey: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  detailVal: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  perSection: {
    width: "100%",
    marginTop: 4,
  },
  perTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  perRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  perBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  perTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  perIndex: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  perTarget: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  perScore: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    minWidth: 32,
    textAlign: "right",
  },
});
