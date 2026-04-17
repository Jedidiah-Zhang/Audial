import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useAudioPlayer } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";

interface SentenceArticleProps {
  text: string;
  voice?: string;
  accentColor: string;
  showPlayAll?: boolean;
  visible?: boolean;
  onPlay?: () => void;
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?。！？؟])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

export function SentenceArticle({
  text,
  voice = "nova",
  accentColor,
  showPlayAll = true,
  visible = true,
  onPlay,
}: SentenceArticleProps) {
  const colors = useColors();
  const { playTTS, stop, isLoading } = useAudioPlayer();
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [isSequence, setIsSequence] = useState(false);
  const sequenceCancelRef = useRef(false);

  const sentences = useMemo(() => splitSentences(text), [text]);

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
      await playTTS(sentences[idx], voice, () => {
        setActiveIdx(null);
      });
    },
    [sentences, voice, playTTS, stop, onPlay]
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
        playTTS(sentences[i], voice, () => {
          if (sequenceCancelRef.current) return;
          setTimeout(() => playFrom(i + 1), 250);
        });
      };
      playFrom(startIdx);
    },
    [sentences, voice, playTTS, onPlay]
  );

  const stopAll = useCallback(() => {
    sequenceCancelRef.current = true;
    setIsSequence(false);
    setActiveIdx(null);
    stop();
  }, [stop]);

  const isAnyPlaying = activeIdx !== null;

  return (
    <View style={styles.container}>
      {visible ? (
        <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.article, { color: colors.foreground }]}>
            {sentences.map((sent, i) => {
              const isActive = activeIdx === i;
              return (
                <Text
                  key={i}
                  onPress={() => playOne(i)}
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
                  {i < sentences.length - 1 ? " " : ""}
                </Text>
              );
            })}
          </Text>

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
                {isLoading ? "加载中..." : isSequence ? "继续播放" : "播放全文"}
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
    gap: 6,
    alignItems: "center",
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
  },
});
