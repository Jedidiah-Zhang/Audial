import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import type { LearningText } from "@/types";
import { DIFFICULTY_LABELS, STAGES } from "@/types";

interface TextCardProps {
  item: LearningText;
  onPress: () => void;
  onDelete?: () => void;
  stagesPassed?: boolean[];
}

const DIFF_COLORS: Record<string, string> = {
  beginner: "#22c55e",
  elementary: "#3b82f6",
  intermediate: "#f59e0b",
  advanced: "#ef4444",
};

export function TextCard({ item, onPress, onDelete, stagesPassed }: TextCardProps) {
  const colors = useColors();
  const [showDelete, setShowDelete] = useState(false);

  const diffColor = DIFF_COLORS[item.difficulty] ?? colors.primary;
  const passedCount = stagesPassed ? stagesPassed.filter(Boolean).length : 0;
  const totalStages = STAGES.length;
  const allDone = passedCount === totalStages;
  const hasStarted = passedCount > 0;
  const currentStage = stagesPassed ? STAGES[passedCount] : STAGES[0];

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={() => setShowDelete(true)}
      activeOpacity={0.85}
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: allDone ? "#10B981" + "60" : colors.border,
          borderWidth: allDone ? 1.5 : 1,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.diffBadge, { backgroundColor: `${diffColor}20` }]}>
          <Text style={[styles.diffText, { color: diffColor }]}>
            {DIFFICULTY_LABELS[item.difficulty]}
          </Text>
        </View>
        <Text style={[styles.lang, { color: colors.mutedForeground }]}>
          {item.targetLanguage.toUpperCase()}
        </Text>
      </View>

      <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
        {item.title}
      </Text>

      <Text style={[styles.preview, { color: colors.mutedForeground }]} numberOfLines={2}>
        {item.text}
      </Text>

      <View style={styles.footer}>
        <Text style={[styles.topic, { color: colors.mutedForeground }]}>
          {item.topic}
        </Text>

        {allDone ? (
          <View style={[styles.progressBadge, { backgroundColor: "#10B981" + "20" }]}>
            <Feather name="star" size={11} color="#10B981" />
            <Text style={[styles.progressText, { color: "#10B981" }]}>已掌握</Text>
          </View>
        ) : hasStarted ? (
          <View style={[styles.progressBadge, { backgroundColor: currentStage.color + "20" }]}>
            <Feather name={currentStage.icon as any} size={11} color={currentStage.color} />
            <Text style={[styles.progressText, { color: currentStage.color }]}>
              第{passedCount + 1}关 · {currentStage.name}
            </Text>
          </View>
        ) : (
          <View style={[styles.progressBadge, { backgroundColor: colors.muted }]}>
            <Feather name="play" size={11} color={colors.mutedForeground} />
            <Text style={[styles.progressText, { color: colors.mutedForeground }]}>开始学习</Text>
          </View>
        )}
      </View>

      {hasStarted && !allDone && (
        <View style={[styles.stageRow, { backgroundColor: colors.muted }]}>
          {STAGES.map((s, i) => (
            <View
              key={i}
              style={[
                styles.stageDot,
                {
                  backgroundColor: stagesPassed?.[i]
                    ? s.color
                    : i === passedCount
                    ? s.color + "40"
                    : colors.border,
                  flex: 1,
                },
              ]}
            />
          ))}
        </View>
      )}

      {allDone && (
        <View style={[styles.stageRow, { backgroundColor: "#10B981" + "30" }]}>
          {STAGES.map((s, i) => (
            <View key={i} style={[styles.stageDot, { backgroundColor: s.color, flex: 1 }]} />
          ))}
        </View>
      )}

      {showDelete && onDelete && (
        <TouchableOpacity
          style={[styles.deleteBtn, { backgroundColor: colors.destructive }]}
          onPress={() => {
            setShowDelete(false);
            onDelete();
          }}
        >
          <Feather name="trash-2" size={16} color="#fff" />
          <Text style={styles.deleteText}>删除</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    marginBottom: 12,
    gap: 8,
    position: "relative",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  diffBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  diffText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  lang: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  title: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 22,
  },
  preview: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  topic: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  progressBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  progressText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  stageRow: {
    flexDirection: "row",
    borderRadius: 4,
    overflow: "hidden",
    height: 4,
    gap: 2,
    marginTop: 2,
  },
  stageDot: {
    height: 4,
    borderRadius: 2,
  },
  deleteBtn: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: 80,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  deleteText: {
    color: "#fff",
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
});
