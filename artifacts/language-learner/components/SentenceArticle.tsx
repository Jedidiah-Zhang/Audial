import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { ChevronLeft, ChevronRight, Info, PlayCircle, Square } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useAudioPlayer, prefetchTTS } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";
import { useApp } from "@/context/AppContext";
import { VOICE_OPTIONS } from "@/types";
import type { ContentType } from "@/types";
import { detectContentType, CONTENT_TYPE_META } from "@/utils/contentType";
import { buildSentenceLayout, flattenSentences } from "@/utils/sentences";
import { useT, getContentTypeLabel } from "@/utils/i18n";
import { Icon, type IconName } from "@/components/Icon";
import { getDefaultVoiceForLanguage } from "@/utils/voiceForLanguage";
import { rtlTextStyle } from "@/utils/rtl";

interface SentenceArticleProps {
  text: string;
  voice?: string;
  accentColor: string;
  showPlayAll?: boolean;
  visible?: boolean;
  onPlay?: () => void;
  contentType?: ContentType;
  /** Maximum height (px) of the scrollable text card. 0 / undefined => no cap. */
  maxTextHeight?: number;
  /** Owning article id, used to scope persistent TTS cache cleanup. */
  articleId?: string;
  /** When true, sentence taps and Play All controls are disabled (e.g. during mic recording). */
  disablePlayback?: boolean;
  /**
   * The article's target language code (e.g. `en-US`, `en-GB`). When the user
   * has not manually picked a voice, we default to a voice matching this
   * language's accent (en-GB → fable, en-US → nova). An explicit `voice` prop
   * always wins.
   */
  targetLanguage?: string;
  /**
   * Optional gate invoked before any sentence playback (single-tap or
   * play-all). Receives the global sentence index. Return `true` to
   * allow the play, `false` to deny (the caller is expected to surface
   * its own UI, e.g. a "watch ad to unlock" modal).
   *
   * Used by the dictation phase to enforce a per-sentence "listen again"
   * quota for free users without coupling this component to the quota
   * model itself.
   */
  playGate?: (sentenceIndex: number) => boolean;
}

const SPEED_OPTIONS: { label: string; value: number }[] = [
  { label: "0.5x", value: 0.5 },
  { label: "0.75x", value: 0.75 },
  { label: "1x", value: 1.0 },
];

export function SentenceArticle({
  text,
  voice: voiceProp,
  accentColor,
  showPlayAll = true,
  visible = true,
  onPlay,
  contentType,
  maxTextHeight = 320,
  articleId,
  disablePlayback = false,
  targetLanguage,
  playGate,
}: SentenceArticleProps) {
  const colors = useColors();
  const t = useT();
  const { settings, updateSettings, userId } = useApp();
  // Resolve the effective voice with this priority:
  //   1. explicit `voice` prop (always wins),
  //   2. user's preferred voice if they've manually picked one,
  //   3. language-default voice for the article's targetLanguage,
  //   4. user's preferred voice fallback,
  //   5. hard fallback to "nova".
  const voice =
    voiceProp ??
    (settings.preferredVoiceUserSet
      ? settings.preferredVoice
      : getDefaultVoiceForLanguage(targetLanguage) ?? settings.preferredVoice) ??
    "nova";
  const { playTTS, stop, isLoading, setRate } = useAudioPlayer({
    articleId,
    userId,
  });
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  // Tracks the most recent sentence the user listened to (or is listening to),
  // so the prev/next buttons can step from a stable cursor even after a
  // sentence finishes playing and `activeIdx` clears back to null.
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);
  const [isSequence, setIsSequence] = useState(false);
  const [rate, setRateState] = useState<number>(1);
  const sequenceCancelRef = useRef(false);

  const effectiveType: ContentType = useMemo(
    () => contentType ?? detectContentType(text),
    [contentType, text]
  );

  // Build the layout. For dialogue, the speaker labels are NOT part of the
  // playable sentences (we don't read names aloud). For paragraph-based types
  // we just split each paragraph into sentences.
  const layout = useMemo(
    () => buildSentenceLayout(text, effectiveType),
    [effectiveType, text]
  );

  // Flat list of sentences to actually play (excludes speaker labels)
  const playableSentences = useMemo(() => flattenSentences(layout), [layout]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const s of playableSentences) {
        if (cancelled) return;
        await prefetchTTS(s, voice, { userId, articleId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playableSentences, voice, userId, articleId]);

  useEffect(() => {
    return () => {
      sequenceCancelRef.current = true;
      stop();
    };
  }, [stop]);

  // If the article (and therefore the playable sentence list) changes, reset
  // the prev/next cursor and any active highlight so we never index out of
  // range on the new list.
  useEffect(() => {
    sequenceCancelRef.current = true;
    setIsSequence(false);
    setActiveIdx(null);
    setCursorIdx(null);
  }, [playableSentences]);

  // Hard-stop any in-flight TTS playback the moment playback is disabled
  // (e.g. user starts recording). Keeps mic input clean.
  useEffect(() => {
    if (disablePlayback) {
      sequenceCancelRef.current = true;
      setIsSequence(false);
      setActiveIdx(null);
      stop();
    }
  }, [disablePlayback, stop]);

  const playOne = useCallback(
    async (idx: number) => {
      // Consult the play gate (e.g. dictation listen-again quota) before
      // touching playback state. A denied gate must not interrupt any
      // currently-playing sentence — the user's request is a no-op.
      if (playGate && !playGate(idx)) return;
      sequenceCancelRef.current = true;
      setIsSequence(false);
      stop();
      setActiveIdx(idx);
      setCursorIdx(idx);
      onPlay?.();
      await playTTS(
        playableSentences[idx],
        voice,
        () => {
          setActiveIdx((cur) => (cur === idx ? null : cur));
        },
        rate
      );
    },
    [playableSentences, voice, playTTS, stop, onPlay, rate, playGate]
  );

  const playPrev = useCallback(() => {
    if (playableSentences.length === 0) return;
    const target =
      cursorIdx === null ? 0 : Math.max(0, cursorIdx - 1);
    playOne(target);
  }, [cursorIdx, playOne, playableSentences.length]);

  const playNext = useCallback(() => {
    if (playableSentences.length === 0) return;
    const target =
      cursorIdx === null
        ? 0
        : Math.min(playableSentences.length - 1, cursorIdx + 1);
    playOne(target);
  }, [cursorIdx, playOne, playableSentences.length]);

  const playSequence = useCallback(
    (startIdx: number = 0) => {
      // Gate the very first sentence; if it's denied, abort the whole
      // sequence (Play All is implicitly a request for sentence #0).
      if (playGate && !playGate(startIdx)) return;
      sequenceCancelRef.current = false;
      setIsSequence(true);
      onPlay?.();

      const playFrom = (i: number) => {
        if (sequenceCancelRef.current || i >= playableSentences.length) {
          setActiveIdx(null);
          setIsSequence(false);
          return;
        }
        // Gate every subsequent sentence. If the user runs out of plays
        // mid-sequence we stop cleanly rather than silently skipping.
        if (i !== startIdx && playGate && !playGate(i)) {
          setActiveIdx(null);
          setIsSequence(false);
          return;
        }
        setActiveIdx(i);
        setCursorIdx(i);
        if (i + 1 < playableSentences.length) {
          prefetchTTS(playableSentences[i + 1], voice, { userId, articleId });
        }
        playTTS(
          playableSentences[i],
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
    [playableSentences, voice, playTTS, onPlay, rate, userId, articleId, playGate]
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
      // Once the user explicitly picks a voice, mark the preference as
      // user-set so future articles stop auto-switching to a language
      // default behind their back.
      updateSettings({ preferredVoice: newVoice, preferredVoiceUserSet: true });
    },
    [stop, updateSettings]
  );

  const isAnyPlaying = activeIdx !== null;

  return (
    <View style={styles.container}>
      {visible ? (
        <View
          style={[
            styles.textCard,
            { backgroundColor: colors.card, borderColor: colors.border },
            maxTextHeight ? { maxHeight: maxTextHeight + 60 } : null,
          ]}
        >
          <ScrollView
            style={maxTextHeight ? { maxHeight: maxTextHeight } : undefined}
            contentContainerStyle={{ paddingRight: 4 }}
            showsVerticalScrollIndicator
            nestedScrollEnabled
          >
          {(() => {
            const renderSentence = (globalIdx: number, sent: string, isLastInGroup: boolean) => {
              const isActive = activeIdx === globalIdx;
              return (
                <Text
                  key={globalIdx}
                  onPress={disablePlayback ? undefined : () => playOne(globalIdx)}
                  suppressHighlighting
                  style={[
                    styles.sentence,
                    isActive && {
                      backgroundColor: accentColor + "33",
                      color: accentColor,
                    },
                    rtlTextStyle(sent),
                  ]}
                >
                  {sent}
                  {!isLastInGroup ? " " : ""}
                </Text>
              );
            };

            const meta = CONTENT_TYPE_META[effectiveType];
            const Badge = meta.showBadge ? (
              <View style={[styles.contentTypeBadge, { backgroundColor: accentColor + "18" }]}>
                <Icon name={meta.icon as any} size={10} color={accentColor} />
                <Text style={[styles.contentTypeBadgeText, { color: accentColor }]}>
                  {getContentTypeLabel(effectiveType, settings.nativeLanguage)}
                </Text>
              </View>
            ) : null;

            if (layout.kind === "dialogue") {
              let cursor = 0;
              return (
                <View style={styles.dialogueWrap}>
                  {Badge}
                  {layout.groups.map((g, gi) => {
                    const isAlt = gi % 2 === 1;
                    return (
                      <View
                        key={gi}
                        style={[styles.turn, isAlt && styles.turnAlt]}
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
                          <Text
                            style={[
                              styles.article,
                              { color: colors.foreground },
                              rtlTextStyle(g.sentences.join(" ")),
                            ]}
                          >
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

            // Paragraph-based layout for news/email/letter/speech/story/essay/general
            let cursor = 0;
            const indent = effectiveType === "news" || effectiveType === "essay";
            return (
              <View style={styles.newsWrap}>
                {Badge}
                {layout.groups.map((g, gi) => (
                  <Text
                    key={gi}
                    style={[
                      styles.article,
                      styles.newsParagraph,
                      { color: colors.foreground },
                      rtlTextStyle(g.sentences.join(" ")),
                    ]}
                  >
                    {indent && gi !== 0 ? <Text>{"   "}</Text> : null}
                    {g.sentences.map((s, i) => {
                      const idx = cursor++;
                      return renderSentence(idx, s, i === g.sentences.length - 1);
                    })}
                  </Text>
                ))}
              </View>
            );
          })()}
          </ScrollView>

          <View style={[styles.hintRow, { borderTopColor: colors.border }]}>
            <Info size={11} color={colors.mutedForeground} />
            <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
              {t("sentence.hint", { n: playableSentences.length })}
            </Text>
          </View>
        </View>
      ) : null}

      {showPlayAll && !disablePlayback && (
        <View style={styles.controls}>
          <View style={styles.voiceSection}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              {t("sentence.voice")}
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
            <Text style={[styles.speedLabel, { color: colors.mutedForeground }]}>{t("sentence.speed")}</Text>
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

          {(() => {
            const total = playableSentences.length;
            // Prev is disabled when there is no current sentence to step
            // back from (cursorIdx===null) or we're already at the first
            // sentence. Critically, `isLoading` does NOT gate prev/next:
            // disabling them during TTS load felt like the buttons were
            // permanently stuck right after the first tap.
            const prevDisabled =
              total === 0 || cursorIdx === null || cursorIdx === 0;
            // Next walks forward; from the initial null state it starts
            // at sentence 0, so it stays enabled. Only disabled when
            // already on the last sentence.
            const nextDisabled =
              total === 0 ||
              (cursorIdx !== null && cursorIdx >= total - 1);
            // Show a "Sentence i / N" indicator. In dictation mode the
            // article body is hidden, so we always surface progress to
            // give the user a sense of position. In normal viewing modes
            // we keep the legacy behaviour of only showing it during a
            // continuous play-all run.
            const showProgress =
              total > 0 && (!visible || (isSequence && activeIdx !== null));
            const progressIdx = activeIdx ?? cursorIdx ?? 0;
            return (
              <View style={styles.stepGroup}>
                {showProgress && (
                  <Text
                    style={[
                      styles.progressLabel,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {t("sentence.progress", {
                      i: progressIdx + 1,
                      n: total,
                    })}
                  </Text>
                )}
                <View style={styles.stepRow}>
                <TouchableOpacity
                  onPress={playPrev}
                  disabled={prevDisabled}
                  activeOpacity={0.85}
                  style={[
                    styles.stepBtn,
                    {
                      backgroundColor: colors.muted,
                      borderColor: colors.border,
                      opacity: prevDisabled ? 0.4 : 1,
                    },
                  ]}
                >
                  <ChevronLeft size={16} color={colors.foreground} />
                  <Text style={[styles.stepBtnText, { color: colors.foreground }]}>
                    {t("sentence.prev")}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={playNext}
                  disabled={nextDisabled}
                  activeOpacity={0.85}
                  style={[
                    styles.stepBtn,
                    {
                      backgroundColor: colors.muted,
                      borderColor: colors.border,
                      opacity: nextDisabled ? 0.4 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.stepBtnText, { color: colors.foreground }]}>
                    {t("sentence.next")}
                  </Text>
                  <ChevronRight size={16} color={colors.foreground} />
                </TouchableOpacity>
                </View>
              </View>
            );
          })()}

          {isAnyPlaying ? (
            <TouchableOpacity
              onPress={stopAll}
              style={[styles.bigBtn, { backgroundColor: "#EF4444" }]}
              activeOpacity={0.85}
            >
              <Square size={20} color="#fff" />
              <Text style={styles.bigBtnText}>{t("sentence.stop")}</Text>
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
                <PlayCircle size={22} color="#fff" />
              )}
              <Text style={styles.bigBtnText}>
                {isLoading ? t("sentence.loading") : t("sentence.playAll")}
              </Text>
            </TouchableOpacity>
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
  stepGroup: {
    width: "100%",
    gap: 6,
  },
  stepRow: {
    flexDirection: "row",
    gap: 8,
    width: "100%",
  },
  stepBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  stepBtnText: {
    fontSize: 13,
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
