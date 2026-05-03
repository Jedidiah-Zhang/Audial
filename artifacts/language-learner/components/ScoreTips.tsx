import React from "react";
import { View, Text, StyleSheet } from "react-native";
import {
  Sparkles,
  Target,
  Volume2,
  Activity,
  Music,
  Lightbulb,
  CheckCircle2,
} from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import type { ScoreTip, ScoreTipIcon } from "@/utils/scoreTips";

interface ScoreTipsProps {
  tips: ScoreTip[];
  encouragement: boolean;
}

function iconFor(icon: ScoreTipIcon, color: string) {
  switch (icon) {
    case "accuracy":
      return <Target size={16} color={color} />;
    case "confidence":
      return <Volume2 size={16} color={color} />;
    case "pace":
      return <Activity size={16} color={color} />;
    case "prosody":
      return <Music size={16} color={color} />;
    case "hint":
      return <Lightbulb size={16} color={color} />;
    case "coverage":
      return <CheckCircle2 size={16} color={color} />;
  }
}

export function ScoreTips({ tips, encouragement }: ScoreTipsProps) {
  const colors = useColors();
  const t = useT();

  if (encouragement) {
    return (
      <View
        style={[
          styles.container,
          { backgroundColor: colors.muted, borderColor: colors.border },
        ]}
      >
        <View style={styles.header}>
          <Sparkles size={14} color={colors.primary} />
          <Text style={[styles.title, { color: colors.mutedForeground }]}>
            {t("tips.section.title")}
          </Text>
        </View>
        <Text style={[styles.encourage, { color: colors.foreground }]}>
          {t("tips.encouragement")}
        </Text>
      </View>
    );
  }

  if (tips.length === 0) return null;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.muted, borderColor: colors.border },
      ]}
    >
      <View style={styles.header}>
        <Sparkles size={14} color={colors.primary} />
        <Text style={[styles.title, { color: colors.mutedForeground }]}>
          {t("tips.section.title")}
        </Text>
      </View>
      <View style={styles.list}>
        {tips.map((tip) => (
          <View key={tip.id} style={styles.row}>
            <View
              style={[
                styles.iconWrap,
                { backgroundColor: colors.primary + "1A" },
              ]}
            >
              {iconFor(tip.icon, colors.primary)}
            </View>
            <View style={styles.textWrap}>
              <Text style={[styles.reason, { color: colors.foreground }]}>
                {t(tip.reasonKey, tip.params)}
              </Text>
              <Text style={[styles.action, { color: colors.mutedForeground }]}>
                {t(tip.actionKey, tip.params)}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
    gap: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  title: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  list: {
    gap: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  reason: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 18,
  },
  action: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
  },
  encourage: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 19,
  },
});
