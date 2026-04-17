import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import type { LearningText } from "@/types";
import { DIFFICULTY_LABELS } from "@/types";

interface TextCardProps {
  item: LearningText;
  onPress: () => void;
  onDelete?: () => void;
  bestScore?: number;
}

const DIFF_COLORS: Record<string, string> = {
  beginner: "#22c55e",
  elementary: "#3b82f6",
  intermediate: "#f59e0b",
  advanced: "#ef4444",
};

export function TextCard({ item, onPress, onDelete, bestScore }: TextCardProps) {
  const colors = useColors();
  const [showDelete, setShowDelete] = useState(false);

  const diffColor = DIFF_COLORS[item.difficulty] ?? colors.primary;

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={() => setShowDelete(true)}
      activeOpacity={0.85}
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
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
        {bestScore !== undefined && (
          <View style={[styles.scoreBadge, { backgroundColor: colors.secondary }]}>
            <Feather name="star" size={11} color={colors.primary} />
            <Text style={[styles.scoreText, { color: colors.primary }]}>
              {bestScore}
            </Text>
          </View>
        )}
      </View>

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
    marginTop: 4,
  },
  topic: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  scoreBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  scoreText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
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
