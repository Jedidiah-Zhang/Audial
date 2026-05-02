import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { Check, X, Volume2, Lock, Sparkles } from "lucide-react-native";
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
  onSentencePress?: (row: PerSentenceRow) => void;
  playingIndex?: number | null;
  /**
   * When true, the per-sentence breakdown is rendered behind a blur with
   * a "watch ad to unlock" CTA. The summary score / feedback / details
   * remain visible — only the granular row data is hidden so free users
   * still see meaningful signal.
   */
  analysisLocked?: boolean;
  /** Invoked when the user taps the unlock CTA. */
  onUnlockAnalysis?: () => void;
  /** True while a rewarded ad is being shown / token granted. */
  isUnlocking?: boolean;
}

export function ScoreCard({
  score,
  feedback,
  details,
  mode,
  perSentence,
  onSentencePress,
  playingIndex,
  analysisLocked = false,
  onUnlockAnalysis,
  isUnlocking = false,
}: ScoreCardProps) {
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
        {/* Stacked column — the big score is the only thing on its own line so
            it sits at the geometric center of the circle. The `/100` caption
            is rendered as a smaller secondary line beneath it; previously
            both numbers shared a single row with `alignItems: baseline`,
            which pushed the dominant score visibly to the left because the
            "/100" suffix occupied real horizontal space. */}
        <Text style={[styles.scoreText, { color: getScoreColor() }]}>{score}</Text>
        <Text style={[styles.scoreMax, { color: colors.mutedForeground }]}>/100</Text>
      </View>

      <Text style={[styles.scoreLabel, { color: getScoreColor() }]}>{getScoreEmoji()}</Text>

      <View style={[styles.bar, { backgroundColor: colors.muted }]}>
        {(() => {
          const widthValue: `${number}%` = `${Math.max(0, Math.min(100, score))}%`;
          return (
            <View
              style={[
                styles.barFill,
                { width: widthValue, backgroundColor: getScoreColor() },
              ]}
            />
          );
        })()}
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
          <View style={styles.perBodyWrap}>
          {perSentence.map((p) => {
            const tone = p.passed ? "#10B981" : "#EF4444";
            const preview = p.target.length > 36 ? p.target.slice(0, 36) + "…" : p.target;
            const tappable = !p.passed && !!onSentencePress;
            const isPlaying = playingIndex === p.index;
            const rowContent = (
              <>
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
                {tappable ? (
                  <View style={styles.perPlayIcon}>
                    {isPlaying ? (
                      <ActivityIndicator size="small" color={tone} />
                    ) : (
                      <Volume2 size={16} color={tone} />
                    )}
                  </View>
                ) : null}
                <Text style={[styles.perScore, { color: tone }]}>{p.score}</Text>
              </>
            );
            if (tappable) {
              return (
                <TouchableOpacity
                  key={p.index}
                  onPress={() => onSentencePress?.(p)}
                  activeOpacity={0.7}
                  style={[
                    styles.perRow,
                    {
                      borderTopColor: colors.border,
                      backgroundColor: isPlaying ? tone + "12" : "transparent",
                    },
                  ]}
                >
                  {rowContent}
                </TouchableOpacity>
              );
            }
            return (
              <View
                key={p.index}
                style={[styles.perRow, { borderTopColor: colors.border }]}
              >
                {rowContent}
              </View>
            );
          })}
          </View>
          {analysisLocked ? (
            <View style={styles.lockOverlay} pointerEvents="box-none">
              {/* On native, BlurView visually blurs the rows below. On web
                  it falls back to a translucent panel since BlurView's
                  blur effect isn't reliably supported there. */}
              {Platform.OS === "web" ? (
                <View
                  style={[
                    StyleSheet.absoluteFillObject,
                    {
                      backgroundColor:
                        colors.card === "#FFFFFF" || colors.card === "#fff"
                          ? "rgba(255,255,255,0.85)"
                          : "rgba(20,20,20,0.78)",
                    },
                  ]}
                />
              ) : (
                <BlurView
                  intensity={28}
                  tint={colors.background === "#FFFFFF" ? "light" : "dark"}
                  style={StyleSheet.absoluteFillObject}
                />
              )}
              <View style={styles.lockContent} pointerEvents="auto">
                <View
                  style={[
                    styles.lockIconWrap,
                    { backgroundColor: colors.primary + "1F" },
                  ]}
                >
                  <Lock size={18} color={colors.primary} />
                </View>
                <Text style={[styles.lockTitle, { color: colors.foreground }]}>
                  {t("analysis.locked.title")}
                </Text>
                <Text
                  style={[styles.lockBody, { color: colors.mutedForeground }]}
                >
                  {t("analysis.locked.body")}
                </Text>
                <TouchableOpacity
                  onPress={onUnlockAnalysis}
                  disabled={isUnlocking || !onUnlockAnalysis}
                  activeOpacity={0.85}
                  style={[
                    styles.lockCta,
                    {
                      backgroundColor: colors.primary,
                      opacity: isUnlocking || !onUnlockAnalysis ? 0.6 : 1,
                    },
                  ]}
                >
                  {isUnlocking ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Sparkles size={14} color="#fff" />
                  )}
                  <Text style={styles.lockCtaText}>
                    {t("analysis.locked.cta")}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
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
  },
  scoreText: {
    fontSize: 42,
    fontFamily: "Inter_700Bold",
    // Tight lineHeight so the column (score + "/100") still sits at the
    // visual center of the circle; a too-large lineHeight here would push
    // the "/100" into the bottom border.
    lineHeight: 46,
    textAlign: "center",
    includeFontPadding: false,
  },
  scoreMax: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    lineHeight: 14,
    marginTop: 2,
    textAlign: "center",
    letterSpacing: 0.3,
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
  perPlayIcon: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  perBodyWrap: {
    position: "relative",
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: 12,
  },
  lockContent: {
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 6,
    maxWidth: 320,
  },
  lockIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  lockTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  lockBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 17,
    marginBottom: 6,
  },
  lockCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  lockCtaText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});
