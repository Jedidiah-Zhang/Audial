import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import type { LearningMode } from "@/types";
import { MODE_LABELS } from "@/types";

const MODE_DESCRIPTIONS: Record<LearningMode, string> = {
  shadowing: "听原声跟读，AI 评估发音与准确度",
  dictation: "听原声，将听到的内容写下来",
  recitation: "看文章后，不看文本从记忆中背诵",
};

const MODE_ICONS: Record<LearningMode, string> = {
  shadowing: "mic",
  dictation: "edit-2",
  recitation: "award",
};

export default function PracticeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { texts, getProgressForText } = useApp();

  const text = texts.find((t) => t.id === id);
  const progress = text ? getProgressForText(text.id) : undefined;

  const [showTranslation, setShowTranslation] = useState(false);
  const [showVocab, setShowVocab] = useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>文章未找到</Text>
      </View>
    );
  }

  const getBestScore = (mode: LearningMode) => {
    if (!progress) return 0;
    return mode === "shadowing"
      ? progress.shadowingBest
      : mode === "dictation"
      ? progress.dictationBest
      : progress.recitationBest;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
          {text.title}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.textContent, { color: colors.foreground }]}>
            {text.text}
          </Text>

          <TouchableOpacity
            onPress={() => setShowTranslation(!showTranslation)}
            style={[styles.toggleBtn, { borderColor: colors.border }]}
            activeOpacity={0.7}
          >
            <Feather
              name={showTranslation ? "eye-off" : "eye"}
              size={14}
              color={colors.mutedForeground}
            />
            <Text style={[styles.toggleText, { color: colors.mutedForeground }]}>
              {showTranslation ? "隐藏翻译" : "显示翻译"}
            </Text>
          </TouchableOpacity>

          {showTranslation && text.translation ? (
            <Text style={[styles.translation, { color: colors.mutedForeground, borderTopColor: colors.border }]}>
              {text.translation}
            </Text>
          ) : null}
        </View>

        {text.vocabulary && text.vocabulary.length > 0 && (
          <TouchableOpacity
            onPress={() => setShowVocab(!showVocab)}
            style={[styles.vocabToggle, { backgroundColor: colors.muted }]}
            activeOpacity={0.8}
          >
            <Feather name="book" size={14} color={colors.primary} />
            <Text style={[styles.vocabToggleText, { color: colors.primary }]}>
              词汇 ({text.vocabulary.length})
            </Text>
            <Feather
              name={showVocab ? "chevron-up" : "chevron-down"}
              size={14}
              color={colors.primary}
            />
          </TouchableOpacity>
        )}

        {showVocab && text.vocabulary.length > 0 && (
          <View style={[styles.vocabCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {text.vocabulary.map((v, i) => (
              <View
                key={i}
                style={[styles.vocabRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}
              >
                <View style={styles.vocabLeft}>
                  <Text style={[styles.vocabWord, { color: colors.foreground }]}>{v.word}</Text>
                  {v.pronunciation ? (
                    <Text style={[styles.vocabPron, { color: colors.mutedForeground }]}>
                      {v.pronunciation}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.vocabMeaning, { color: colors.mutedForeground }]}>
                  {v.meaning}
                </Text>
              </View>
            ))}
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>选择练习模式</Text>

        {(["shadowing", "dictation", "recitation"] as LearningMode[]).map((mode) => {
          const best = getBestScore(mode);
          const hasScore = best > 0;
          return (
            <TouchableOpacity
              key={mode}
              onPress={() =>
                router.push({ pathname: "/session", params: { id: text.id, mode } })
              }
              activeOpacity={0.85}
              style={[styles.modeCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[styles.modeIcon, { backgroundColor: colors.secondary }]}>
                <Feather name={MODE_ICONS[mode] as any} size={22} color={colors.primary} />
              </View>
              <View style={styles.modeInfo}>
                <Text style={[styles.modeName, { color: colors.foreground }]}>
                  {MODE_LABELS[mode]}
                </Text>
                <Text style={[styles.modeDesc, { color: colors.mutedForeground }]}>
                  {MODE_DESCRIPTIONS[mode]}
                </Text>
              </View>
              <View style={styles.modeRight}>
                {hasScore && (
                  <Text style={[styles.modeScore, { color: colors.primary }]}>{best}</Text>
                )}
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    flex: 1,
    textAlign: "center",
    marginHorizontal: 8,
  },
  content: {
    paddingHorizontal: 20,
    gap: 12,
  },
  textCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    gap: 12,
  },
  textContent: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 26,
  },
  toggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  toggleText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  translation: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  vocabToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  vocabToggleText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  vocabCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  vocabRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    gap: 8,
  },
  vocabLeft: { flex: 1 },
  vocabWord: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  vocabPron: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  vocabMeaning: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
    textAlign: "right",
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    marginTop: 8,
  },
  modeCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    gap: 14,
  },
  modeIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  modeInfo: { flex: 1 },
  modeName: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 3,
  },
  modeDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  modeRight: {
    alignItems: "flex-end",
    gap: 4,
  },
  modeScore: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
});
