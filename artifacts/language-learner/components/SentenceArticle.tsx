import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAudioPlayer, prefetchTTS } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";
import { useApp } from "@/context/AppContext";
import { VOICE_OPTIONS } from "@/types";
import type { ContentType } from "@/types";
import { detectContentType, parseDialogue, parseParagraphs } from "@/utils/contentType";

interface SentenceArticleProps {
  text: string;
  voice?: string;
  accentColor: string;
  showPlayAll?: boolean;
  visible?: boolean;
  onPlay?: () => void;
  contentType?: ContentType;
}

const SPEED_OPTIONS: { label: string; value: number }[] = [
  { label: "0.5x", value: 0.5 },
  { label: "0.75x", value: 0.75 },
  { label: "1x", value: 1.0 },
];

function splitSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^.!?。！？؟\n]+[.!?。！？؟]+["'”’」』）)]*|[^.!?。！？؟\n]+/g);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter(Boolean);
}

export function SentenceArticle({
  text,
  voice: voiceProp,
  accentColor,
  showPlayAll = true,
  visible = true,
  onPlay,
  contentType,
}: SentenceArticleProps) {
  const colors = useColors();
  const { settings, updateSettings } = useApp();
  const voice = voiceProp ?? settings.preferredVoice ?? "nova";
  const { playTTS, stop, isLoading, setRate } = useAudioPlayer();
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [isSequence, setIsSequence] = useState(false);
  const [rate, setRateState] = useState<number>(1);
  const sequenceCancelRef = useRef(false);

  const sentences = useMemo(() => splitSentences(text), [text]);
  const effectiveType: ContentType = useMemo(
    () => contentType ?? detectContentType(text),
    [contentType, text]
  );

  // Build a per-sentence layout map so that, regardless of structure (dialogue / news / general),
  // we can keep a single global sentence index for play-all and active highlighting.
  const layout = useMemo(() => {
    if (effectiveType === "dialogue") {
      const turns = parseDialogue(text);
      const groups = turns.map((t) => ({
        speaker: t.speaker,
        sentences: splitSentences(t.utterance),
      }));
      return { kind: "dialogue" as const, groups };
    }
    if (effectiveType === "news") {
      const paragraphs = parseParagraphs(text);
      const groups = paragraphs.map((p) => ({ sentences: splitSentences(p) }));
      return { kind: "news" as const, groups };
    }
    return { kind: "general" as const };
  }, [effectiveType, text]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const s of sentences) {
        if (cancelled) return;
        await prefetchTTS(s, voice);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sentences, voice]);

  useEffect(() => {
    return () => {
      sequenceCancelRef.current = true;
      stop();
    };
  }, [stop]);

  const playOne = useCallback(
    async (idx: number) => {
      sequenceCancelRef.current = true;
      setIsSequence(false);
      stop();
      setActiveIdx(idx);
      onPlay?.();
      await playTTS(
        sentences[idx],
        voice,
        () => {
          setActiveIdx((cur) => (cur === idx ? null : cur));
        },
        rate
      );
    },
    [sentences, voice, playTTS, stop, onPlay, rate]
  );

  const playSequence = useCallback(
    (startIdx: number = 0) => {
      sequenceCancelRef.current = false;
      setIsSequence(true);
      onPlay?.();

      const playFrom = (i: number) => {
        if (sequenceCancelRef.current || i >= sentences.length) {
          setActiveIdx(null);
          setIsSequence(false);
          return;
        }
        setActiveIdx(i);
        if (i + 1 < sentences.length) {
          prefetchTTS(sentences[i + 1], voice);
        }
        playTTS(
          sentences[i],
          voice,
          () => {
            if (sequenceCancelRef.current) return;
            setTimeout(() => playFrom(i + 1), 350);
          },
          rate
        );
      };
      playFrom(startIdx);
    },
    [sentences, voice, playTTS, onPlay, rate]
  );

  const stopAll = useCallback(() => {
    sequenceCancelRef.current = true;
    setIsSequence(false);
    setActiveIdx(null);
    stop();
  }, [stop]);

  const handleSelectRate = useCallback(
    (newRate: number) => {
      setRateState(newRate);
      setRate(newRate);
    },
    [setRate]
  );

  const handleSelectVoice = useCallback(
    (newVoice: string) => {
      sequenceCancelRef.current = true;
      setIsSequence(false);
      setActiveIdx(null);
      stop();
      updateSettings({ preferredVoice: newVoice });
    },
    [stop, updateSettings]
  );

  const isAnyPlaying = activeIdx !== null;

  return (
    <View style={styles.container}>
      {visible ? (
        <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {(() => {
            const renderSentence = (globalIdx: number, sent: string, isLastInGroup: boolean) => {
              const isActive = activeIdx === globalIdx;
              return (
                <Text
                  key={globalIdx}
                  onPress={() => playOne(globalIdx)}
                  suppressHighlighting
                  style={[
                    styles.sentence,
                    isActive && {
                      backgroundColor: accentColor + "33",
                      color: accentColor,
                    },
                  ]}
                >
                  {sent}
                  {!isLastInGroup ? " " : ""}
                </Text>
              );
            };

            if (layout.kind === "dialogue") {
              let cursor = 0;
              return (
                <View style={styles.dialogueWrap}>
                  <View style={[styles.contentTypeBadge, { backgroundColor: accentColor + "18" }]}>
                    <Feather name="message-circle" size={10} color={accentColor} />
                    <Text style={[styles.contentTypeBadgeText, { color: accentColor }]}>
                      对话
                    </Text>
                  </View>
                  {layout.groups.map((g, gi) => {
                    const isAlt = gi % 2 === 1;
                    return (
                      <View
                        key={gi}
                        style={[
                          styles.turn,
                          isAlt && styles.turnAlt,
                        ]}
                      >
                        <View
                          style={[
                            styles.speakerChip,
                            {
                              backgroundColor: isAlt ? accentColor + "18" : colors.muted,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.speakerText,
                              { color: isAlt ? accentColor : colors.foreground },
                            ]}
                            numberOfLines={1}
                          >
                            {g.speaker}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.bubble,
                            {
                              backgroundColor: isAlt ? accentColor + "10" : colors.muted,
                              alignSelf: isAlt ? "flex-end" : "flex-start",
                              borderColor: isAlt ? accentColor + "33" : colors.border,
                            },
                          ]}
                        >
                          <Text style={[styles.article, { color: colors.foreground }]}>
                            {g.sentences.map((s, i) => {
                              const idx = cursor++;
                              return renderSentence(idx, s, i === g.sentences.length - 1);
                            })}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              );
            }

            if (layout.kind === "news") {
              let cursor = 0;
              return (
                <View style={styles.newsWrap}>
                  <View style={[styles.contentTypeBadge, { backgroundColor: accentColor + "18" }]}>
                    <Feather name="file-text" size={10} color={accentColor} />
                    <Text style={[styles.contentTypeBadgeText, { color: accentColor }]}>
                      新闻 / 文章
                    </Text>
                  </View>
                  {layout.groups.map((g, gi) => (
                    <Text
                      key={gi}
                      style={[
                        styles.article,
                        styles.newsParagraph,
                        { color: colors.foreground },
                      ]}
                    >
                      {gi === 0 ? null : <Text>{"   "}</Text>}
                      {g.sentences.map((s, i) => {
                        const idx = cursor++;
                        return renderSentence(idx, s, i === g.sentences.length - 1);
                      })}
                    </Text>
                  ))}
                </View>
              );
            }

            return (
              <Text style={[styles.article, { color: colors.foreground }]}>
                {sentences.map((sent, i) =>
                  renderSentence(i, sent, i === sentences.length - 1)
                )}
              </Text>
            );
          })()}

          <View style={[styles.hintRow, { borderTopColor: colors.border }]}>
            <Feather name="info" size={11} color={colors.mutedForeground} />
            <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
              点击任意句子单独播放（共 {sentences.length} 句）
            </Text>
          </View>
        </View>
      ) : null}

      {showPlayAll && (
        <View style={styles.controls}>
          <View style={styles.voiceSection}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              音色
            </Text>
            <View style={styles.voiceGrid}>
              {VOICE_OPTIONS.map((opt) => {
                const active = voice === opt.id;
                const genderLabel =
                  opt.gender === "female" ? "♀" : opt.gender === "male" ? "♂" : "·";
                return (
                  <TouchableOpacity
                    key={opt.id}
                    onPress={() => handleSelectVoice(opt.id)}
                    activeOpacity={0.85}
                    style={[
                      styles.voiceChip,
                      {
                        backgroundColor: active ? accentColor : colors.muted,
                        borderColor: active ? accentColor : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.voiceChipGender,
                        { color: active ? "#fff" : colors.mutedForeground },
                      ]}
                    >
                      {genderLabel}
                    </Text>
                    <View style={styles.voiceChipTextWrap}>
                      <Text
                        style={[
                          styles.voiceChipName,
                          { color: active ? "#fff" : colors.foreground },
                        ]}
                      >
                        {opt.label}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.voiceChipDesc,
                          {
                            color: active ? "rgba(255,255,255,0.85)" : colors.mutedForeground,
                          },
                        ]}
                      >
                        {opt.description}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={[styles.speedRow, { backgroundColor: colors.muted }]}>
            <Text style={[styles.speedLabel, { color: colors.mutedForeground }]}>语速</Text>
            {SPEED_OPTIONS.map((opt) => {
              const active = rate === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => handleSelectRate(opt.value)}
                  activeOpacity={0.8}
                  style={[
                    styles.speedBtn,
                    active && { backgroundColor: accentColor },
                  ]}
                >
                  <Text
                    style={[
                      styles.speedBtnText,
                      { color: active ? "#fff" : colors.foreground },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {isAnyPlaying ? (
            <TouchableOpacity
              onPress={stopAll}
              style={[styles.bigBtn, { backgroundColor: "#EF4444" }]}
              activeOpacity={0.85}
            >
              <Feather name="square" size={20} color="#fff" />
              <Text style={styles.bigBtnText}>停止播放</Text>
              <AudioWaveform isActive color="#fff" barCount={4} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={() => playSequence(0)}
              disabled={isLoading}
              style={[styles.bigBtn, {
                backgroundColor: accentColor,
                opacity: isLoading ? 0.6 : 1,
              }]}
              activeOpacity={0.85}
            >
              {isLoading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Feather name="play-circle" size={22} color="#fff" />
              )}
              <Text style={styles.bigBtnText}>
                {isLoading ? "加载中..." : "播放全文"}
              </Text>
            </TouchableOpacity>
          )}

          {isSequence && activeIdx !== null && (
            <Text style={[styles.progressLabel, { color: colors.mutedForeground }]}>
              第 {activeIdx + 1} / {sentences.length} 句
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  textCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
  },
  article: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 30,
  },
  sentence: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 30,
    borderRadius: 4,
  },
  contentTypeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginBottom: 10,
  },
  contentTypeBadgeText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  dialogueWrap: {
    gap: 10,
  },
  turn: {
    gap: 4,
    alignItems: "flex-start",
  },
  turnAlt: {
    alignItems: "flex-end",
  },
  speakerChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    maxWidth: "60%",
  },
  speakerText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    maxWidth: "92%",
  },
  newsWrap: {
    gap: 10,
  },
  newsParagraph: {
    marginBottom: 4,
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  hintText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  controls: {
    gap: 10,
    alignItems: "stretch",
  },
  voiceSection: {
    gap: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    paddingHorizontal: 2,
  },
  voiceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    flexBasis: "32%",
    flexGrow: 1,
    minWidth: 0,
  },
  voiceChipGender: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    width: 12,
    textAlign: "center",
  },
  voiceChipTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  voiceChipName: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  voiceChipDesc: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  speedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    alignSelf: "center",
  },
  speedLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginRight: 4,
  },
  speedBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    minWidth: 44,
    alignItems: "center",
  },
  speedBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  bigBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    width: "100%",
  },
  bigBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  progressLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    alignSelf: "center",
  },
});
