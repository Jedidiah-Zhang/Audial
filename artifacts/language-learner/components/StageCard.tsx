import React, { forwardRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  View as RNView,
} from "react-native";
import { Check, ChevronRight, Lock } from "lucide-react-native";
import { Icon } from "@/components/Icon";
import { useColors } from "@/hooks/useColors";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import { useT, getStageName, getStageDesc } from "@/utils/i18n";
import { flipIfRTL } from "@/utils/rtl";

export type StageCardProps = {
  idx: number;
  locked: boolean;
  passed: boolean;
  current: boolean;
  best: number;
  lang: string;
  onPress?: () => void;
  // When true, this is rendered as a static visual (e.g. inside the
  // card-expand overlay snapshot on /session). It is non-interactive
  // and skips press feedback.
  snapshot?: boolean;
};

export const StageCard = forwardRef<RNView, StageCardProps>(function StageCard(
  { idx, locked, passed, current, best, lang, onPress, snapshot = false },
  ref,
) {
  const colors = useColors();
  const t = useT();
  const stage = STAGES[idx];

  const borderColor = current
    ? stage.color
    : passed
    ? stage.color + "60"
    : colors.border;
  const borderWidth = current ? 2 : 1;

  const cardStyle = [
    styles.stageCard,
    {
      backgroundColor: colors.card,
      borderColor,
      borderWidth,
      opacity: locked ? 0.45 : 1,
    },
  ];

  const inner = (
    <>
      <View
        style={[
          styles.stageBadge,
          {
            backgroundColor: passed
              ? stage.color
              : current
              ? stage.color + "20"
              : colors.muted,
          },
        ]}
      >
        {passed ? (
          <Check size={20} color="#fff" />
        ) : locked ? (
          <Lock size={18} color={colors.mutedForeground} />
        ) : (
          <Icon name={stage.icon as any} size={20} color={stage.color} />
        )}
      </View>

      <View style={styles.stageInfo}>
        <View style={styles.stageHeader}>
          <Text style={[styles.stageNum, { color: colors.mutedForeground }]}>
            {t("practice.stageNum", { n: idx + 1 })}
          </Text>
          {current && (
            <View style={[styles.currentTag, { backgroundColor: stage.color }]}>
              <Text style={styles.currentTagText}>{t("practice.current")}</Text>
            </View>
          )}
        </View>
        <Text
          style={[
            styles.stageName,
            { color: locked ? colors.mutedForeground : colors.foreground },
          ]}
        >
          {getStageName(idx, lang)}
        </Text>
        <Text
          style={[styles.stageDesc, { color: colors.mutedForeground }]}
          numberOfLines={2}
        >
          {getStageDesc(idx, lang)}
        </Text>
        {stage.needsScore && (
          <Text
            style={[styles.stageThreshold, { color: colors.mutedForeground }]}
          >
            {t("practice.passReq", { n: STAGE_PASS_SCORE })}
          </Text>
        )}
      </View>

      <View style={styles.stageRight}>
        {best > 0 ? (
          <View style={styles.scoreBlock}>
            <Text
              style={[
                styles.scoreBig,
                { color: passed ? stage.color : colors.mutedForeground },
              ]}
            >
              {best}
            </Text>
            <Text style={[styles.scoreLabel, { color: colors.mutedForeground }]}>
              {t("practice.bestLabel")}
            </Text>
          </View>
        ) : locked ? null : (
          <ChevronRight size={20} color={stage.color} style={flipIfRTL()} />
        )}
      </View>
    </>
  );

  if (snapshot) {
    return (
      <View ref={ref} style={cardStyle} pointerEvents="none">
        {inner}
      </View>
    );
  }

  return (
    <TouchableOpacity
      ref={ref as any}
      onPress={onPress}
      disabled={locked}
      activeOpacity={locked ? 1 : 0.85}
      style={cardStyle}
    >
      {inner}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  stageCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 18,
    padding: 16,
    gap: 14,
    marginBottom: 10,
    zIndex: 1,
  },
  stageBadge: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stageInfo: {
    flex: 1,
    gap: 2,
  },
  stageHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stageNum: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  currentTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  currentTagText: {
    color: "#fff",
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
  },
  stageName: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
  },
  stageDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
  },
  stageThreshold: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  stageRight: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 40,
  },
  scoreBlock: {
    alignItems: "center",
  },
  scoreBig: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },
  scoreLabel: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
  },
});
