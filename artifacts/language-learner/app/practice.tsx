import React, { useState } from "react";
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
import { SentenceArticle } from "@/components/SentenceArticle";
import { STAGES, STAGE_PASS_SCORE } from "@/types";

export default function PracticeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { texts, getProgressForText, settings } = useApp();

  const text = texts.find((t) => t.id === id);
  const progress = text ? getProgressForText(text.id) : undefined;

  const [showVocab, setShowVocab] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>文章未找到</Text>
      </View>
    );
  }

  const stagePassed = progress?.stagePassed ?? STAGES.map(() => false);
  const stageBests = progress?.stageBests ?? STAGES.map(() => 0);

  const isUnlocked = (idx: number) => idx === 0 || stagePassed[idx - 1];
  const isPassed = (idx: number) => stagePassed[idx];
  const isCurrent = (idx: number) => isUnlocked(idx) && !isPassed(idx);

  const allPassed = STAGES.every((_, i) => stagePassed[i]);
  const totalScore = stageBests.filter((s) => s > 0).length > 0
    ? Math.round(stageBests.reduce((a, b) => a + b, 0) / STAGES.length)
    : 0;

  const handleStartStage = (stageIdx: number) => {
    if (!isUnlocked(stageIdx)) return;
    router.push({ pathname: "/session", params: { id: text.id, stage: stageIdx.toString() } });
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
        <SentenceArticle
          text={text.text}
          voice={settings.preferredVoice}
          accentColor={colors.primary}
        />

        <View style={styles.textActions}>
          {text.translation ? (
            <TouchableOpacity
              onPress={() => setShowTranslation(!showTranslation)}
              style={[styles.pillBtn, { borderColor: colors.border }]}
              activeOpacity={0.7}
            >
              <Feather name={showTranslation ? "eye-off" : "eye"} size={13} color={colors.mutedForeground} />
              <Text style={[styles.pillBtnText, { color: colors.mutedForeground }]}>
                {showTranslation ? "隐藏译文" : "显示译文"}
              </Text>
            </TouchableOpacity>
          ) : null}
          {text.vocabulary?.length > 0 ? (
            <TouchableOpacity
              onPress={() => setShowVocab(!showVocab)}
              style={[styles.pillBtn, { borderColor: colors.border }]}
              activeOpacity={0.7}
            >
              <Feather name="book" size={13} color={colors.mutedForeground} />
              <Text style={[styles.pillBtnText, { color: colors.mutedForeground }]}>
                词汇 ({text.vocabulary.length})
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {showTranslation && text.translation ? (
          <View style={[styles.translationCard, { backgroundColor: colors.muted }]}>
            <Text style={[styles.translationLabel, { color: colors.mutedForeground }]}>译文</Text>
            <Text style={[styles.translation, { color: colors.foreground }]}>
              {text.translation}
            </Text>
          </View>
        ) : null}

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
                    <Text style={[styles.vocabPron, { color: colors.mutedForeground }]}>{v.pronunciation}</Text>
                  ) : null}
                </View>
                <Text style={[styles.vocabMeaning, { color: colors.mutedForeground }]}>{v.meaning}</Text>
              </View>
            ))}
          </View>
        )}

        {allPassed && (
          <View style={[styles.masteredBanner, { backgroundColor: "#10B981" + "20", borderColor: "#10B981" }]}>
            <Feather name="star" size={20} color="#10B981" />
            <View style={{ flex: 1 }}>
              <Text style={[styles.masteredTitle, { color: "#10B981" }]}>已掌握！</Text>
              <Text style={[styles.masteredSub, { color: "#10B981" + "CC" }]}>综合得分 {totalScore} 分，可重练任意关卡提升分数</Text>
            </View>
          </View>
        )}

        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>学习关卡</Text>

        <View style={styles.stagesContainer}>
          {STAGES.map((stage, idx) => {
            const locked = !isUnlocked(idx);
            const passed = isPassed(idx);
            const current = isCurrent(idx);
            const best = stageBests[idx];

            return (
              <View key={idx} style={styles.stageRow}>
                {idx < STAGES.length - 1 && (
                  <View
                    style={[
                      styles.stageLine,
                      { backgroundColor: passed ? stage.color : colors.border },
                    ]}
                  />
                )}

                <TouchableOpacity
                  onPress={() => handleStartStage(idx)}
                  disabled={locked}
                  activeOpacity={locked ? 1 : 0.85}
                  style={[
                    styles.stageCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: current
                        ? stage.color
                        : passed
                        ? stage.color + "60"
                        : colors.border,
                      borderWidth: current ? 2 : 1,
                      opacity: locked ? 0.45 : 1,
                    },
                  ]}
                >
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
                      <Feather name="check" size={20} color="#fff" />
                    ) : locked ? (
                      <Feather name="lock" size={18} color={colors.mutedForeground} />
                    ) : (
                      <Feather name={stage.icon as any} size={20} color={stage.color} />
                    )}
                  </View>

                  <View style={styles.stageInfo}>
                    <View style={styles.stageHeader}>
                      <Text style={[styles.stageNum, { color: colors.mutedForeground }]}>
                        第 {idx + 1} 关
                      </Text>
                      {current && (
                        <View style={[styles.currentTag, { backgroundColor: stage.color }]}>
                          <Text style={styles.currentTagText}>当前</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.stageName, { color: locked ? colors.mutedForeground : colors.foreground }]}>
                      {stage.name}
                    </Text>
                    <Text style={[styles.stageDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                      {stage.description}
                    </Text>
                    {stage.needsScore && (
                      <Text style={[styles.stageThreshold, { color: colors.mutedForeground }]}>
                        通关要求：{STAGE_PASS_SCORE} 分
                      </Text>
                    )}
                  </View>

                  <View style={styles.stageRight}>
                    {best > 0 ? (
                      <View style={styles.scoreBlock}>
                        <Text style={[styles.scoreBig, { color: passed ? stage.color : colors.mutedForeground }]}>
                          {best}
                        </Text>
                        <Text style={[styles.scoreLabel, { color: colors.mutedForeground }]}>最高</Text>
                      </View>
                    ) : locked ? null : (
                      <Feather name="chevron-right" size={20} color={stage.color} />
                    )}
                  </View>
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
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
    gap: 14,
  },
  textActions: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  pillBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillBtnText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  translationCard: {
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  translationLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  translation: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
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
  masteredBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  masteredTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  masteredSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: -4,
  },
  stagesContainer: {
    gap: 0,
    paddingBottom: 8,
  },
  stageRow: {
    position: "relative",
  },
  stageLine: {
    position: "absolute",
    left: 28,
    bottom: 0,
    width: 2,
    height: 18,
    zIndex: 0,
  },
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
