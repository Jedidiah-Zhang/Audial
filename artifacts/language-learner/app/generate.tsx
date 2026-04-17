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

type Phase = "form" | "preview";

export default function GenerateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { addText, settings } = useApp();

  const [phase, setPhase] = useState<Phase>("form");
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>(settings.defaultDifficulty);
  const [nativeLanguage, setNativeLanguage] = useState(settings.nativeLanguage);
  const [targetLanguage, setTargetLanguage] = useState(settings.targetLanguage);
  const [manualText, setManualText] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualTranslation, setManualTranslation] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftTranslation, setDraftTranslation] = useState("");
  const [draftVocab, setDraftVocab] = useState<VocabularyItem[]>([]);

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

      const result = await response.json() as { success: boolean; data: any };
      if (!result.success) throw new Error("Generation failed");

      setDraftTitle(result.data.title ?? topic);
      setDraftText(result.data.text ?? "");
      setDraftTranslation(result.data.translation ?? "");
      setDraftVocab(result.data.vocabulary ?? []);
      setPhase("preview");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("错误", "生成文本失败，请检查网络后重试");
    } finally {
      setIsGenerating(false);
    }
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

  const handleConfirmDraft = async () => {
    if (!draftText.trim() || !draftTitle.trim()) {
      Alert.alert("提示", "标题和正文不能为空");
      return;
    }
    const text: LearningText = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
      title: draftTitle.trim(),
      text: draftText.trim(),
      translation: draftTranslation.trim(),
      vocabulary: draftVocab,
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

  const handleRegenerate = async () => {
    setPhase("form");
    await handleGenerate();
  };

  const handleUpdateVocab = (idx: number, patch: Partial<VocabularyItem>) => {
    setDraftVocab((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const handleRemoveVocab = (idx: number) => {
    setDraftVocab((prev) => prev.filter((_, i) => i !== idx));
  };

  const inputStyle = { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground };
  const labelStyle = { color: colors.mutedForeground };

  if (phase === "preview") {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad + 12 }]}>
          <TouchableOpacity onPress={() => setPhase("form")} style={styles.backBtn} activeOpacity={0.7}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>预览与编辑</Text>
          <TouchableOpacity
            onPress={handleRegenerate}
            disabled={isGenerating}
            style={styles.backBtn}
            activeOpacity={0.7}
          >
            {isGenerating ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="refresh-cw" size={20} color={colors.primary} />
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.content, { paddingBottom: Platform.OS === "web" ? 50 : insets.bottom + 40 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.tipBox, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "40" }]}>
            <Feather name="info" size={14} color={colors.primary} />
            <Text style={[styles.tipText, { color: colors.primary }]}>
              确认前可任意修改。保存后正文与词汇将不可再改，标题始终可改。
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>标题</Text>
            <TextInput
              style={[styles.input, inputStyle]}
              value={draftTitle}
              onChangeText={setDraftTitle}
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>正文</Text>
            <TextInput
              style={[styles.textarea, inputStyle, { minHeight: 160 }]}
              value={draftText}
              onChangeText={setDraftText}
              multiline
              textAlignVertical="top"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>翻译</Text>
            <TextInput
              style={[styles.textarea, inputStyle]}
              value={draftTranslation}
              onChangeText={setDraftTranslation}
              multiline
              textAlignVertical="top"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          {draftVocab.length > 0 && (
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>词汇 ({draftVocab.length})</Text>
              <View style={{ gap: 10 }}>
                {draftVocab.map((v, i) => (
                  <View
                    key={i}
                    style={[styles.vocabEdit, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={styles.vocabEditRow}>
                      <TextInput
                        style={[styles.vocabInput, inputStyle, { flex: 1 }]}
                        value={v.word}
                        onChangeText={(t) => handleUpdateVocab(i, { word: t })}
                        placeholder="单词"
                        placeholderTextColor={colors.mutedForeground}
                      />
                      <TouchableOpacity
                        onPress={() => handleRemoveVocab(i)}
                        style={[styles.vocabRemove, { borderColor: colors.border }]}
                        activeOpacity={0.7}
                      >
                        <Feather name="x" size={14} color={colors.destructive} />
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      style={[styles.vocabInput, inputStyle]}
                      value={v.meaning}
                      onChangeText={(t) => handleUpdateVocab(i, { meaning: t })}
                      placeholder="释义"
                      placeholderTextColor={colors.mutedForeground}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}

          <TouchableOpacity
            onPress={handleConfirmDraft}
            style={[styles.generateBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Feather name="check" size={18} color="#fff" />
            <Text style={styles.generateBtnText}>确认保存</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>添加文章</Text>
        <View style={{ width: 36 }} />
      </View>

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

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: Platform.OS === "web" ? 50 : insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
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
  tipBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  tipText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    lineHeight: 17,
  },
  vocabEdit: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  vocabEditRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  vocabInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  vocabRemove: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
