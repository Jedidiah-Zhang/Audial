import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { LANGUAGES, DIFFICULTY_LABELS } from "@/types";
import type { Difficulty, LearningText, VocabularyItem } from "@/types";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

const TOPICS = [
  "日常对话", "旅行", "工作职场", "家庭生活", "饮食文化",
  "体育运动", "科技新闻", "环境气候", "历史文化", "医疗健康",
];

interface DraftPreview {
  title: string;
  text: string;
  translation: string;
  vocabulary: VocabularyItem[];
}

export default function GenerateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { addText, settings } = useApp();

  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>(settings.defaultDifficulty);
  const [nativeLanguage, setNativeLanguage] = useState(settings.nativeLanguage);
  const [targetLanguage, setTargetLanguage] = useState(settings.targetLanguage);
  const [manualText, setManualText] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualTranslation, setManualTranslation] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  const [draft, setDraft] = useState<DraftPreview | null>(null);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const handleGenerate = async () => {
    if (!topic.trim()) {
      Alert.alert("提示", "请输入或选择一个话题");
      return;
    }

    setIsGenerating(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const response = await fetch(`${BASE_URL}/api/language/generate-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          difficulty,
          language: LANGUAGES.find((l) => l.code === nativeLanguage)?.name ?? "中文",
          targetLanguage: LANGUAGES.find((l) => l.code === targetLanguage)?.name ?? "English",
        }),
      });

      const result = (await response.json()) as { success: boolean; data: any };
      if (!result.success) throw new Error("Generation failed");

      setDraft({
        title: result.data.title ?? topic,
        text: result.data.text ?? "",
        translation: result.data.translation ?? "",
        vocabulary: result.data.vocabulary ?? [],
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("错误", "生成文本失败，请检查网络后重试");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleConfirmDraft = async () => {
    if (!draft) return;
    if (!draft.title.trim() || !draft.text.trim()) {
      Alert.alert("提示", "标题和正文都不能为空");
      return;
    }
    const text: LearningText = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
      title: draft.title.trim(),
      text: draft.text.trim(),
      translation: draft.translation.trim(),
      vocabulary: draft.vocabulary,
      topic,
      difficulty,
      targetLanguage,
      nativeLanguage,
      createdAt: Date.now(),
    };
    await addText(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const handleDiscardDraft = () => {
    setDraft(null);
  };

  const handleManualSave = async () => {
    if (!manualTitle.trim() || !manualText.trim()) {
      Alert.alert("提示", "请输入标题和文本内容");
      return;
    }

    const text: LearningText = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
      title: manualTitle.trim(),
      text: manualText.trim(),
      translation: manualTranslation.trim(),
      vocabulary: [],
      topic: "自定义",
      difficulty,
      targetLanguage,
      nativeLanguage,
      createdAt: Date.now(),
    };

    await addText(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const inputStyle = { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground };
  const labelStyle = { color: colors.mutedForeground };

  const renderDraftPreview = () => {
    if (!draft) return null;
    return (
      <>
        <View style={[styles.previewBanner, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "40" }]}>
          <Feather name="edit-2" size={14} color={colors.primary} />
          <Text style={[styles.previewBannerText, { color: colors.primary }]}>
            请检查并修改生成内容，确认后将无法再修改正文
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, labelStyle]}>标题</Text>
          <TextInput
            style={[styles.input, inputStyle]}
            value={draft.title}
            onChangeText={(v) => setDraft({ ...draft, title: v })}
            placeholder="文章标题"
            placeholderTextColor={colors.mutedForeground}
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, labelStyle]}>正文（目标语言）</Text>
          <TextInput
            style={[styles.textarea, inputStyle, { minHeight: 200 }]}
            value={draft.text}
            onChangeText={(v) => setDraft({ ...draft, text: v })}
            multiline
            textAlignVertical="top"
          />
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            正文一旦确认保存就不能再修改，请仔细校对
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, labelStyle]}>翻译</Text>
          <TextInput
            style={[styles.textarea, inputStyle]}
            value={draft.translation}
            onChangeText={(v) => setDraft({ ...draft, translation: v })}
            multiline
            textAlignVertical="top"
          />
        </View>

        {draft.vocabulary.length > 0 && (
          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>词汇 ({draft.vocabulary.length})</Text>
            <View style={[styles.vocabPreview, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              {draft.vocabulary.map((v, i) => (
                <View
                  key={i}
                  style={[
                    styles.vocabPreviewRow,
                    i > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
                  ]}
                >
                  <Text style={[styles.vocabPreviewWord, { color: colors.foreground }]}>{v.word}</Text>
                  <Text style={[styles.vocabPreviewMeaning, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {v.meaning}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.draftActions}>
          <TouchableOpacity
            onPress={handleDiscardDraft}
            disabled={isGenerating}
            style={[styles.secondaryBtn, { borderColor: colors.border }]}
            activeOpacity={0.8}
          >
            <Feather name="refresh-cw" size={16} color={colors.foreground} />
            <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>重新生成</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleConfirmDraft}
            style={[styles.generateBtn, { backgroundColor: colors.primary, flex: 1, marginTop: 0 }]}
            activeOpacity={0.85}
          >
            <Feather name="check" size={18} color="#fff" />
            <Text style={styles.generateBtnText}>确认保存</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity
          onPress={() => (draft ? handleDiscardDraft() : router.back())}
          style={styles.backBtn}
          activeOpacity={0.7}
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          {draft ? "确认文章" : "添加文章"}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      {!draft && (
        <View style={styles.tabs}>
          {(["ai", "manual"] as const).map((m) => (
            <TouchableOpacity
              key={m}
              onPress={() => setMode(m)}
              style={[
                styles.tab,
                { backgroundColor: mode === m ? colors.primary : colors.muted },
              ]}
              activeOpacity={0.8}
            >
              <Feather
                name={m === "ai" ? "cpu" : "edit-3"}
                size={14}
                color={mode === m ? "#fff" : colors.mutedForeground}
              />
              <Text
                style={[
                  styles.tabText,
                  { color: mode === m ? "#fff" : colors.mutedForeground },
                ]}
              >
                {m === "ai" ? "AI 生成" : "手动输入"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: Platform.OS === "web" ? 50 : insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {draft ? (
          renderDraftPreview()
        ) : (
          <>
            <View style={styles.row}>
              <View style={styles.field}>
                <Text style={[styles.label, labelStyle]}>母语</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.langScroll}>
                  {LANGUAGES.map((lang) => (
                    <TouchableOpacity
                      key={lang.code}
                      onPress={() => setNativeLanguage(lang.code)}
                      style={[
                        styles.langChip,
                        {
                          backgroundColor: nativeLanguage === lang.code ? colors.primary : colors.muted,
                          borderColor: nativeLanguage === lang.code ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text style={{ color: nativeLanguage === lang.code ? "#fff" : colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                        {lang.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>目标语言</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.langScroll}>
                {LANGUAGES.filter((l) => l.code !== nativeLanguage).map((lang) => (
                  <TouchableOpacity
                    key={lang.code}
                    onPress={() => setTargetLanguage(lang.code)}
                    style={[
                      styles.langChip,
                      {
                        backgroundColor: targetLanguage === lang.code ? colors.primary : colors.muted,
                        borderColor: targetLanguage === lang.code ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text style={{ color: targetLanguage === lang.code ? "#fff" : colors.foreground, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                      {lang.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>难度</Text>
              <View style={styles.diffRow}>
                {(["beginner", "elementary", "intermediate", "advanced"] as Difficulty[]).map((d) => (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setDifficulty(d)}
                    style={[
                      styles.diffChip,
                      {
                        backgroundColor: difficulty === d ? colors.primary : colors.muted,
                        flex: 1,
                      },
                    ]}
                  >
                    <Text style={{ color: difficulty === d ? "#fff" : colors.foreground, fontSize: 12, fontFamily: "Inter_500Medium", textAlign: "center" }}>
                      {DIFFICULTY_LABELS[d]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {mode === "ai" ? (
              <>
                <View style={styles.field}>
                  <Text style={[styles.label, labelStyle]}>话题</Text>
                  <TextInput
                    style={[styles.input, inputStyle]}
                    value={topic}
                    onChangeText={setTopic}
                    placeholder="输入话题，如：购物、天气..."
                    placeholderTextColor={colors.mutedForeground}
                    returnKeyType="done"
                  />
                </View>

                <View style={styles.field}>
                  <Text style={[styles.label, labelStyle]}>快速选择</Text>
                  <View style={styles.topicGrid}>
                    {TOPICS.map((t) => (
                      <TouchableOpacity
                        key={t}
                        onPress={() => setTopic(t)}
                        style={[
                          styles.topicChip,
                          {
                            backgroundColor: topic === t ? colors.secondary : colors.muted,
                            borderColor: topic === t ? colors.primary : "transparent",
                          },
                        ]}
                      >
                        <Text style={{ color: topic === t ? colors.primary : colors.foreground, fontSize: 13, fontFamily: "Inter_400Regular" }}>
                          {t}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                <TouchableOpacity
                  onPress={handleGenerate}
                  disabled={isGenerating}
                  style={[styles.generateBtn, { backgroundColor: colors.primary, opacity: isGenerating ? 0.7 : 1 }]}
                  activeOpacity={0.85}
                >
                  {isGenerating ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Feather name="zap" size={18} color="#fff" />
                      <Text style={styles.generateBtnText}>AI 生成文章</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <View style={styles.field}>
                  <Text style={[styles.label, labelStyle]}>标题</Text>
                  <TextInput
                    style={[styles.input, inputStyle]}
                    value={manualTitle}
                    onChangeText={setManualTitle}
                    placeholder="文章标题"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={[styles.label, labelStyle]}>目标语言文本</Text>
                  <TextInput
                    style={[styles.textarea, inputStyle]}
                    value={manualText}
                    onChangeText={setManualText}
                    placeholder="在此输入或粘贴目标语言的文本..."
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    textAlignVertical="top"
                  />
                </View>

                <View style={styles.field}>
                  <Text style={[styles.label, labelStyle]}>翻译（可选）</Text>
                  <TextInput
                    style={[styles.textarea, inputStyle]}
                    value={manualTranslation}
                    onChangeText={setManualTranslation}
                    placeholder="中文翻译（可选）"
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    textAlignVertical="top"
                  />
                </View>

                <TouchableOpacity
                  onPress={handleManualSave}
                  style={[styles.generateBtn, { backgroundColor: colors.primary }]}
                  activeOpacity={0.85}
                >
                  <Feather name="save" size={18} color="#fff" />
                  <Text style={styles.generateBtnText}>保存文章</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}
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
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 20,
    marginBottom: 16,
    gap: 8,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  tabText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  content: {
    paddingHorizontal: 20,
    gap: 16,
  },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  field: {
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
  },
  hint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  langScroll: {
    flexGrow: 0,
  },
  langChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 8,
  },
  diffRow: {
    flexDirection: "row",
    gap: 6,
  },
  diffChip: {
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  textarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    minHeight: 120,
  },
  topicGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  topicChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  generateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 8,
  },
  generateBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  previewBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  previewBannerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flex: 1,
  },
  vocabPreview: {
    borderRadius: 10,
    borderWidth: 1,
  },
  vocabPreviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 10,
  },
  vocabPreviewWord: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  vocabPreviewMeaning: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
    textAlign: "right",
  },
  draftActions: {
    flexDirection: "row",
    gap: 10,
    alignItems: "stretch",
    marginTop: 8,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
