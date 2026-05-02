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
  Modal,
  FlatList,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Check, ChevronDown, Edit3, RefreshCw, Save, Zap } from "lucide-react-native";
import { flipIfRTL } from "@/utils/rtl";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { LANGUAGES } from "@/types";
import type { ContentType, Difficulty, LearningText, VocabularyItem } from "@/types";
import { detectContentType, isContentType } from "@/utils/contentType";
import { useT, getDifficultyLabel, TOPIC_KEYS } from "@/utils/i18n";
import { Icon } from "@/components/Icon";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

interface DraftPayload {
  title: string;
  text: string;
  translation: string;
  vocabulary: VocabularyItem[];
  contentType: ContentType;
}

export default function GenerateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { addText, settings } = useApp();

  const nativeLanguage = settings.nativeLanguage;
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>(settings.defaultDifficulty);
  const [targetLanguage, setTargetLanguage] = useState(settings.targetLanguage);
  const [manualText, setManualText] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);

  const targetLangObj = LANGUAGES.find((l) => l.code === targetLanguage) ?? LANGUAGES[1];
  const nativeLangObj = LANGUAGES.find((l) => l.code === nativeLanguage) ?? LANGUAGES[0];

  // Preview/edit phase
  const [draft, setDraft] = useState<DraftPayload | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftTranslation, setDraftTranslation] = useState("");

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const handleGenerate = async () => {
    if (!topic.trim()) {
      Alert.alert(t("common.tip"), t("generate.alert.topicEmpty"));
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
          language: LANGUAGES.find((l) => l.code === nativeLanguage)?.english ?? "English",
          targetLanguage: LANGUAGES.find((l) => l.code === targetLanguage)?.name ?? "English",
        }),
      });

      const result = await response.json() as { success: boolean; data: any };
      if (!result.success) throw new Error("Generation failed");

      const rawText = result.data.text ?? "";
      const declaredType = result.data.contentType as ContentType | undefined;
      const payload: DraftPayload = {
        title: result.data.title ?? topic,
        text: rawText,
        translation: result.data.translation ?? "",
        vocabulary: result.data.vocabulary ?? [],
        contentType: isContentType(declaredType) ? declaredType : detectContentType(rawText),
      };
      setDraft(payload);
      setDraftTitle(payload.title);
      setDraftText(payload.text);
      setDraftTranslation(payload.translation);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert(t("common.error"), t("generate.alert.failed"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleConfirmDraft = async () => {
    if (!draft) return;
    if (!draftTitle.trim() || !draftText.trim()) {
      Alert.alert(t("common.tip"), t("generate.alert.titleTextEmpty"));
      return;
    }
    const finalText = draftText.trim();
    const text: LearningText = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      title: draftTitle.trim(),
      text: finalText,
      translation: draftTranslation.trim(),
      vocabulary: draft.vocabulary,
      topic: topic || t("topic.custom"),
      difficulty,
      targetLanguage,
      nativeLanguage,
      createdAt: Date.now(),
      contentType: draft.contentType,
    };
    await addText(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const handleDiscardDraft = () => {
    setDraft(null);
    setDraftTitle("");
    setDraftText("");
    setDraftTranslation("");
  };

  const handleManualSave = async () => {
    if (!manualTitle.trim() || !manualText.trim()) {
      Alert.alert(t("common.tip"), t("generate.alert.manualEmpty"));
      return;
    }

    const finalText = manualText.trim();
    setIsTranslating(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    let translation = "";
    try {
      const resp = await fetch(`${BASE_URL}/api/language/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: finalText,
          fromLanguage: targetLangObj.english,
          toLanguage: nativeLangObj.english,
        }),
      });
      const result = (await resp.json()) as { success: boolean; data?: { translation?: string } };
      if (result.success) translation = result.data?.translation ?? "";
    } catch {
      // proceed without translation if network fails
    } finally {
      setIsTranslating(false);
    }

    const text: LearningText = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      title: manualTitle.trim(),
      text: finalText,
      translation,
      vocabulary: [],
      topic: t("topic.custom"),
      difficulty,
      targetLanguage,
      nativeLanguage,
      createdAt: Date.now(),
      contentType: detectContentType(finalText),
    };

    await addText(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const inputStyle = { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground };
  const labelStyle = { color: colors.mutedForeground };

  // ============ DRAFT PREVIEW MODE ============
  if (draft) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad + 12 }]}>
          <TouchableOpacity onPress={handleDiscardDraft} style={styles.backBtn} activeOpacity={0.7}>
            <ArrowLeft size={22} color={colors.foreground} style={flipIfRTL()} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>{t("generate.preview.headerTitle")}</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.content, { paddingBottom: Platform.OS === "web" ? 50 : insets.bottom + 40 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.previewBanner, { backgroundColor: colors.primary + "15", borderColor: colors.primary + "40" }]}>
            <Edit3 size={14} color={colors.primary} />
            <Text style={[styles.previewBannerText, { color: colors.primary }]}>
              {t("generate.preview.banner")}
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>{t("generate.label.title")}</Text>
            <TextInput
              style={[styles.input, inputStyle]}
              value={draftTitle}
              onChangeText={setDraftTitle}
              placeholder={t("generate.placeholder.title")}
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>{t("generate.label.body")}</Text>
            <TextInput
              style={[styles.bigTextarea, inputStyle]}
              value={draftText}
              onChangeText={setDraftText}
              placeholder={t("generate.placeholder.text")}
              placeholderTextColor={colors.mutedForeground}
              multiline
              textAlignVertical="top"
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, labelStyle]}>{t("generate.label.translation")}</Text>
            <TextInput
              style={[styles.textarea, inputStyle]}
              value={draftTranslation}
              onChangeText={setDraftTranslation}
              placeholder={t("generate.placeholder.translationOpt")}
              placeholderTextColor={colors.mutedForeground}
              multiline
              textAlignVertical="top"
            />
          </View>

          {draft.vocabulary.length > 0 && (
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.preview.vocab", { count: draft.vocabulary.length })}</Text>
              <View style={[styles.vocabPreview, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {draft.vocabulary.map((v, i) => (
                  <View
                    key={i}
                    style={[
                      styles.vocabRow,
                      i > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.vocabWord, { color: colors.foreground }]}>{v.word}</Text>
                    <Text style={[styles.vocabMeaning, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {v.meaning}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={handleGenerate}
              disabled={isGenerating}
              style={[styles.regenerateBtn, { borderColor: colors.border, opacity: isGenerating ? 0.6 : 1 }]}
              activeOpacity={0.85}
            >
              {isGenerating ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <RefreshCw size={16} color={colors.foreground} />
              )}
              <Text style={[styles.regenerateBtnText, { color: colors.foreground }]}>
                {isGenerating ? t("generate.btn.generating") : t("generate.preview.regenerate")}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleConfirmDraft}
              style={[styles.confirmBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.85}
            >
              <Check size={18} color="#fff" />
              <Text style={styles.confirmBtnText}>{t("generate.preview.confirm")}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ============ FORM MODE (AI / MANUAL) ============
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <ArrowLeft size={22} color={colors.foreground} style={flipIfRTL()} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>{t("generate.title")}</Text>
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
            <Icon
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
              {m === "ai" ? t("generate.tab.ai") : t("generate.tab.manual")}
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
        <View style={styles.field}>
          <Text style={[styles.label, labelStyle]}>{t("generate.label.targetLanguage")}</Text>
          <TouchableOpacity
            onPress={() => setTargetPickerOpen(true)}
            activeOpacity={0.85}
            style={[
              styles.dropdown,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontFamily: "Inter_600SemiBold" }}>
                {targetLangObj.name}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 1 }}>
                {targetLangObj.english}
              </Text>
            </View>
            <ChevronDown size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, labelStyle]}>{t("generate.label.difficulty")}</Text>
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
                  {getDifficultyLabel(d, nativeLanguage)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {mode === "ai" ? (
          <>
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.topic")}</Text>
              <TextInput
                style={[styles.input, inputStyle]}
                value={topic}
                onChangeText={setTopic}
                placeholder={t("generate.placeholder.topic")}
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="done"
              />
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.quickPick")}</Text>
              <View style={styles.topicGrid}>
                {TOPIC_KEYS.map((tk) => {
                  const label = t(tk);
                  const isActive = topic === label;
                  return (
                    <TouchableOpacity
                      key={tk}
                      onPress={() => setTopic(label)}
                      style={[
                        styles.topicChip,
                        {
                          backgroundColor: isActive ? colors.secondary : colors.muted,
                          borderColor: isActive ? colors.primary : "transparent",
                        },
                      ]}
                    >
                      <Text style={{ color: isActive ? colors.primary : colors.foreground, fontSize: 13, fontFamily: "Inter_400Regular" }}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
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
                  <Zap size={18} color="#fff" />
                  <Text style={styles.generateBtnText}>{t("generate.btn.generate")}</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.title")}</Text>
              <TextInput
                style={[styles.input, inputStyle]}
                value={manualTitle}
                onChangeText={setManualTitle}
                placeholder={t("generate.placeholder.title")}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, labelStyle]}>{t("generate.label.text")}</Text>
              <TextInput
                style={[styles.textarea, inputStyle]}
                value={manualText}
                onChangeText={setManualText}
                placeholder={t("generate.placeholder.text")}
                placeholderTextColor={colors.mutedForeground}
                multiline
                textAlignVertical="top"
              />
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: -2 }}>
                {t("generate.translateNote", { lang: nativeLangObj.name })}
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleManualSave}
              disabled={isTranslating}
              style={[styles.generateBtn, { backgroundColor: colors.primary, opacity: isTranslating ? 0.7 : 1 }]}
              activeOpacity={0.85}
            >
              {isTranslating ? (
                <>
                  <ActivityIndicator color="#fff" />
                  <Text style={styles.generateBtnText}>{t("generate.btn.translatingSaving")}</Text>
                </>
              ) : (
                <>
                  <Save size={18} color="#fff" />
                  <Text style={styles.generateBtnText}>{t("generate.btn.save")}</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      <Modal
        visible={targetPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTargetPickerOpen(false)}
      >
        <View style={styles.pickerOverlay}>
          <TouchableOpacity
            style={styles.pickerBackdrop}
            activeOpacity={1}
            onPress={() => setTargetPickerOpen(false)}
          />
          <View style={[styles.pickerCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.pickerTitle, { color: colors.foreground }]}>
              {t("generate.picker.title")}
            </Text>
            <FlatList
              data={LANGUAGES
                .filter((l) => l.code !== nativeLanguage)
                .slice()
                .sort((a, b) => a.english.localeCompare(b.english))}
              keyExtractor={(l) => l.code}
              style={{ maxHeight: 380 }}
              renderItem={({ item: lang }) => {
                const selected = lang.code === targetLanguage;
                return (
                  <TouchableOpacity
                    onPress={() => {
                      setTargetLanguage(lang.code);
                      setTargetPickerOpen(false);
                    }}
                    style={[
                      styles.pickerRow,
                      { borderBottomColor: colors.border },
                      selected && { backgroundColor: colors.primary + "15" },
                    ]}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{
                        color: selected ? colors.primary : colors.foreground,
                        fontSize: 15,
                        fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium",
                      }}>
                        {lang.name}
                      </Text>
                      <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                        {lang.english}
                      </Text>
                    </View>
                    {selected && (
                      <Check size={18} color={colors.primary} />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
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
  dropdown: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickerOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  pickerCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 4,
    gap: 8,
  },
  pickerTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
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
  bigTextarea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    minHeight: 200,
    lineHeight: 22,
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
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  previewBannerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flex: 1,
    lineHeight: 17,
  },
  vocabPreview: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  vocabRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
    gap: 10,
  },
  vocabWord: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  vocabMeaning: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    flex: 1,
    textAlign: "right",
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  regenerateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  regenerateBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  confirmBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
});
