import React from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { useColors } from "@/hooks/useColors";

interface ScoreCardProps {
  score: number;
  feedback: string;
  details?: Record<string, string | number>;
  mode: "shadowing" | "dictation" | "recitation";
}

export function ScoreCard({ score, feedback, details, mode }: ScoreCardProps) {
  const colors = useColors();

  const getScoreColor = () => {
    if (score >= 90) return colors.success;
    if (score >= 70) return colors.warning;
    return colors.destructive;
  };

  const getScoreEmoji = () => {
    if (score >= 90) return "优秀";
    if (score >= 80) return "良好";
    if (score >= 70) return "一般";
    if (score >= 60) return "加油";
    return "继续练习";
  };

  const modeLabel = { shadowing: "跟读", dictation: "听写", recitation: "背诵" }[mode];

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.modeLabel, { color: colors.mutedForeground }]}>{modeLabel}得分</Text>

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

      <Text style={[styles.feedback, { color: colors.foreground }]}>{feedback}</Text>

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
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    alignItems: "baseline" as any,
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
});
