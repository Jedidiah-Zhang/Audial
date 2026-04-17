import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAudioPlayer } from "@/hooks/useAudio";
import { useApp } from "@/context/AppContext";
import type { VocabularyItem, LearningText } from "@/types";
import { useT } from "@/utils/i18n";

interface Props {
  text: LearningText;
  onUpdateVocabulary?: (vocab: VocabularyItem[]) => void;
}

const API_BASE =
  Platform.OS === "web"
    ? "/api"
    : `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;

export function VocabularyList({ text, onUpdateVocabulary }: Props) {
  const colors = useColors();
  const t = useT();
  const { settings } = useApp();
  const { playTTS } = useAudioPlayer();
  const [items, setItems] = useState<VocabularyItem[]>(text.vocabulary);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [loadingIdx, setLoadingIdx] = useState<number | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const handlePlay = useCallback(
    async (idx: number) => {
      const item = items[idx];
      if (!item) return;
      setPlayingIdx(idx);
      await playTTS(
        item.word,
        settings.preferredVoice ?? "nova",
        () => setPlayingIdx((cur) => (cur === idx ? null : cur)),
        1
      );
    },
    [items, playTTS, settings.preferredVoice]
  );

  const handlePlayExample = useCallback(
    async (sentence: string, key: string) => {
      const idx = -1; // separate state not needed; brief flash
      void idx;
      await playTTS(
        sentence,
        settings.preferredVoice ?? "nova",
        () => {},
        1
      );
    },
    [playTTS, settings.preferredVoice]
  );

  const fetchDetail = useCallback(
    async (idx: number) => {
      const item = items[idx];
      if (!item) return;
      setLoadingIdx(idx);
      try {
        const res = await fetch(`${API_BASE}/language/word-detail`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            word: item.word,
            targetLanguage: text.targetLanguage,
            language: text.nativeLanguage,
          }),
        });
        const json = await res.json();
        if (json?.success && json.data) {
          const updated: VocabularyItem = {
            ...item,
            pronunciation: item.pronunciation || json.data.pronunciation,
            partOfSpeech: item.partOfSpeech || json.data.partOfSpeech,
            example: json.data.example,
            exampleTranslation: json.data.exampleTranslation,
          };
          const next = items.map((it, i) => (i === idx ? updated : it));
          setItems(next);
          onUpdateVocabulary?.(next);
        }
      } catch (e) {
        // ignore
      } finally {
        setLoadingIdx(null);
      }
    },
    [items, text.targetLanguage, text.nativeLanguage, onUpdateVocabulary]
  );

  const toggleExpand = useCallback(
    (idx: number) => {
      setExpandedIdx((cur) => (cur === idx ? null : idx));
      const item = items[idx];
      if (item && !item.example && expandedIdx !== idx) {
        fetchDetail(idx);
      }
    },
    [items, expandedIdx, fetchDetail]
  );

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {items.map((v, i) => {
        const isPlaying = playingIdx === i;
        const isExpanded = expandedIdx === i;
        const isLoading = loadingIdx === i;
        return (
          <View
            key={i}
            style={[
              styles.entry,
              i > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
            ]}
          >
            <View style={styles.headerRow}>
              <View style={styles.wordCol}>
                <View style={styles.wordLine}>
                  <Text style={[styles.word, { color: colors.foreground }]}>{v.word}</Text>
                  <TouchableOpacity
                    onPress={() => handlePlay(i)}
                    activeOpacity={0.7}
                    style={[
                      styles.playBtn,
                      {
                        backgroundColor: isPlaying ? colors.primary : colors.muted,
                      },
                    ]}
                  >
                    <Feather
                      name={isPlaying ? "volume-2" : "volume-1"}
                      size={13}
                      color={isPlaying ? "#fff" : colors.mutedForeground}
                    />
                  </TouchableOpacity>
                </View>
                <View style={styles.metaLine}>
                  {v.partOfSpeech ? (
                    <Text style={[styles.pos, { color: colors.primary, backgroundColor: colors.primary + "15" }]}>
                      {v.partOfSpeech}
                    </Text>
                  ) : null}
                  {v.pronunciation ? (
                    <Text style={[styles.pron, { color: colors.mutedForeground }]}>
                      /{v.pronunciation.replace(/^\/|\/$/g, "")}/
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>

            <Text style={[styles.meaning, { color: colors.foreground }]}>{v.meaning}</Text>

            <TouchableOpacity
              onPress={() => toggleExpand(i)}
              activeOpacity={0.7}
              style={styles.exampleToggle}
            >
              <Feather
                name={isExpanded ? "chevron-up" : "chevron-down"}
                size={13}
                color={colors.mutedForeground}
              />
              <Text style={[styles.exampleToggleText, { color: colors.mutedForeground }]}>
                {isExpanded ? t("vocab.expand") : v.example ? t("vocab.viewExample") : t("vocab.generate")}
              </Text>
              {isLoading ? (
                <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 4 }} />
              ) : null}
            </TouchableOpacity>

            {isExpanded && (
              <View style={[styles.exampleBox, { backgroundColor: colors.muted }]}>
                {v.example ? (
                  <>
                    <View style={styles.exampleHeader}>
                      <Text style={[styles.exampleLabel, { color: colors.mutedForeground }]}>{t("vocab.exampleLabel")}</Text>
                      <TouchableOpacity
                        onPress={() => handlePlayExample(v.example!, `${i}-ex`)}
                        activeOpacity={0.7}
                        style={[styles.examplePlayBtn, { borderColor: colors.border }]}
                      >
                        <Feather name="play" size={11} color={colors.primary} />
                        <Text style={[styles.examplePlayText, { color: colors.primary }]}>{t("vocab.read")}</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.exampleText, { color: colors.foreground }]}>{v.example}</Text>
                    {v.exampleTranslation ? (
                      <Text style={[styles.exampleTranslation, { color: colors.mutedForeground }]}>
                        {v.exampleTranslation}
                      </Text>
                    ) : null}
                  </>
                ) : isLoading ? (
                  <Text style={[styles.exampleText, { color: colors.mutedForeground }]}>{t("vocab.generating")}</Text>
                ) : (
                  <Text style={[styles.exampleText, { color: colors.mutedForeground }]}>{t("vocab.none")}</Text>
                )}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  entry: {
    padding: 14,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  wordCol: {
    flex: 1,
    gap: 4,
  },
  wordLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  word: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
  },
  playBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  pos: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  pron: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  meaning: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    lineHeight: 20,
  },
  exampleToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
  exampleToggleText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  exampleBox: {
    borderRadius: 10,
    padding: 10,
    gap: 6,
    marginTop: 2,
  },
  exampleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  exampleLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  examplePlayBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },
  examplePlayText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
  },
  exampleText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 19,
    fontStyle: "italic",
  },
  exampleTranslation: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
});
