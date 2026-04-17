import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioPlayer, useAudioRecorder, transcribeAudio } from "@/hooks/useAudio";
import { AudioWaveform } from "@/components/AudioWaveform";
import { ScoreCard } from "@/components/ScoreCard";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import type { LearningMode } from "@/types";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

const SPEEDS = [0.75, 1.0, 1.25, 1.5] as const;
type Speed = typeof SPEEDS[number];

type SessionPhase =
  | "intro"
  | "practice"
  | "memorize"
  | "recording"
  | "transcribing"
  | "scoring"
  | "result";

function splitSentences(text: string): string[] {
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?。！？；;…])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 1 ? parts : [text];
}

export default function SessionScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id, stage: stageParam } = useLocalSearchParams<{ id: string; stage: string }>();
  const { texts, addResult, completeListeningStage, settings } = useApp();
  const { playTTS, stop, isPlaying, isLoading: ttsLoading } = useAudioPlayer();
  const { startRecording, stopRecording, isRecording } = useAudioRecorder();

  const stageIdx = parseInt(stageParam ?? "0", 10);
  const stage = STAGES[stageIdx] ?? STAGES[0];
  const text = texts.find((t) => t.id === id);
  const sentences = useMemo(() => (text ? splitSentences(text.text) : []), [text]);

  const [phase, setPhase] = useState<SessionPhase>("intro");
  const [speed, setSpeed] = useState<Speed>(1.0);
  const [currentSentIdx, setCurrentSentIdx] = useState(0);
  const [sentencePlayed, setSentencePlayed] = useState<boolean[]>([]);
  const [sentenceInputs, setSentenceInputs] = useState<string[]>([]);
  const [sentenceTranscripts, setSentenceTranscripts] = useState<string[]>([]);
  const [currentInput, setCurrentInput] = useState("");
  const [memorizeCountdown, setMemorizeCountdown] = useState(30);
  const [result, setResult] = useState<{
    score: number;
    feedback: string;
    details: Record<string, string | number>;
    passed: boolean;
  } | null>(null);

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;
  const stageColor = stage.color;
  const isLastStage = stageIdx === STAGES.length - 1;

  const allSentencesPlayed = sentencePlayed.length === sentences.length && sentencePlayed.every(Boolean);
  const allSentencesDone = useMemo(() => {
    if (stageIdx === 0) return allSentencesPlayed;
    if (stageIdx === 2) return sentenceInputs.length === sentences.length && sentenceInputs.every((s) => s.trim().length > 0);
    return sentenceTranscripts.length === sentences.length && sentenceTranscripts.every((s) => s.trim().length > 0);
  }, [stageIdx, allSentencesPlayed, sentenceInputs, sentenceTranscripts, sentences.length]);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      stop();
    };
  }, []);

  const handlePlayCurrentSentence = useCallback(async () => {
    if (!text) return;
    const sentence = sentences[currentSentIdx] ?? text.text;
    await playTTS(sentence, settings.preferredVoice, speed);
    setSentencePlayed((prev) => {
      const next = [...prev];
      next[currentSentIdx] = true;
      return next;
    });
  }, [sentences, currentSentIdx, playTTS, settings.preferredVoice, speed, text]);

  const goToSentence = useCallback(
    (idx: number) => {
      stop();
      setCurrentSentIdx(idx);
      setCurrentInput(sentenceInputs[idx] ?? "");
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    [sentenceInputs, stop]
  );

  const handleBeginPractice = () => {
    if (stageIdx === 3) {
      setPhase("memorize");
      setMemorizeCountdown(30);
      countdownRef.current = setInterval(() => {
        setMemorizeCountdown((n) => {
          if (n <= 1) {
            clearInterval(countdownRef.current!);
            setPhase("practice");
            setCurrentSentIdx(0);
            return 0;
          }
          return n - 1;
        });
      }, 1000);
    } else {
      setPhase("practice");
      setCurrentSentIdx(0);
      setSentencePlayed([]);
      setSentenceInputs([]);
      setSentenceTranscripts([]);
      setCurrentInput("");
      if (stageIdx === 0 || (stageIdx !== 2 && settings.autoPlayAudio)) {
        setTimeout(() => handlePlayCurrentSentence(), 400);
      }
    }
  };

  const handleRecord = async () => {
    if (isRecording) {
      setPhase("transcribing");
      const blob = await stopRecording();
      if (!blob) {
        setPhase("practice");
        return;
      }
      try {
        const transcript = await transcribeAudio(blob);
        setSentenceTranscripts((prev) => {
          const next = [...prev];
          next[currentSentIdx] = transcript;
          return next;
        });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setPhase("practice");
      } catch {
        Alert.alert("错误", "录音转文字失败，请重试");
        setPhase("practice");
      }
    } else {
      const started = await startRecording();
      if (!started) {
        Alert.alert("需要麦克风权限", "请在设置中允许麦克风访问");
        return;
      }
      setPhase("recording");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  };

  const handleSaveDictationAndNext = () => {
    const trimmed = currentInput.trim();
    if (!trimmed) {
      Alert.alert("提示", "请先输入您听到的内容");
      return;
    }
    setSentenceInputs((prev) => {
      const next = [...prev];
      next[currentSentIdx] = trimmed;
      return next;
    });
    if (currentSentIdx < sentences.length - 1) {
      const nextIdx = currentSentIdx + 1;
      setCurrentSentIdx(nextIdx);
      setCurrentInput(sentenceInputs[nextIdx] ?? "");
    } else {
      setCurrentInput(trimmed);
    }
  };

  const handleCompleteListening = async () => {
    if (!text) return;
    await completeListeningStage(text.id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setResult({ score: 100, feedback: "很好！完成精听练习，进入下一关继续学习。", details: {}, passed: true });
    setPhase("result");
  };

  const handleSubmitForScoring = async () => {
    if (!text) return;
    setPhase("scoring");

    try {
      const endpoint =
        stageIdx === 1
          ? "/api/language/score-pronunciation"
          : stageIdx === 2
          ? "/api/language/score-dictation"
          : "/api/language/score-recitation";

      const userAnswer =
        stageIdx === 2
          ? sentenceInputs.join(" ")
          : sentenceTranscripts.join(" ");

      const body =
        stageIdx === 2
          ? { targetText: text.text, userText: userAnswer, language: text.targetLanguage }
          : { targetText: text.text, transcribedText: userAnswer, language: text.targetLanguage };

      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = (await response.json()) as { success: boolean; data: any };
      if (!json.success) throw new Error("Scoring failed");

      const d = json.data;
      const details: Record<string, string | number> = {};

      if (stageIdx === 1 && d.mistakes?.length) {
        details["发音错误词"] = d.mistakes.join(", ");
      }
      if (stageIdx === 2 && d.wordAccuracy) {
        details["词汇准确率"] = `${d.wordAccuracy}%`;
      }
      if (stageIdx === 3) {
        details["覆盖率"] = `${d.completeness ?? 0}%`;
        details["流利度"] =
          { excellent: "优秀", good: "良好", fair: "一般", needs_work: "需加强" }[
            d.fluency as string
          ] ?? d.fluency;
      }

      const score = d.score ?? 0;
      const passed = score >= STAGE_PASS_SCORE;

      await addResult({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
        textId: text.id,
        mode: stage.mode as LearningMode,
        stage: stageIdx,
        score,
        feedback: d.feedback ?? "",
        createdAt: Date.now(),
        details,
      });

      setResult({ score, feedback: d.feedback ?? "", details, passed });
      Haptics.notificationAsync(
        passed ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
      );
      setPhase("result");
    } catch {
      Alert.alert("评分失败", "无法连接服务器，请检查网络");
      setPhase("practice");
    }
  };

  const handleRetry = () => {
    setResult(null);
    setCurrentSentIdx(0);
    setSentencePlayed([]);
    setSentenceInputs([]);
    setSentenceTranscripts([]);
    setCurrentInput("");
    setPhase("intro");
  };

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>文章未找到</Text>
      </View>
    );
  }

  const sentenceDone = (idx: number) => {
    if (stageIdx === 0) return sentencePlayed[idx] === true;
    if (stageIdx === 2) return (sentenceInputs[idx] ?? "").trim().length > 0;
    return (sentenceTranscripts[idx] ?? "").trim().length > 0;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerStage, { color: stageColor }]}>
            第 {stageIdx + 1} 关 · {stage.name}
          </Text>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {text.title}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
        <View
          style={[
            styles.progressFill,
            { backgroundColor: stageColor, width: `${((stageIdx + 1) / STAGES.length) * 100}%` },
          ]}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {phase === "intro" && (
          <View style={styles.section}>
            <View
              style={[
                styles.introCard,
                { backgroundColor: colors.card, borderColor: stageColor + "40", borderWidth: 2 },
              ]}
            >
              <View style={[styles.introBadge, { backgroundColor: stageColor + "20" }]}>
                <Feather name={stage.icon as any} size={36} color={stageColor} />
              </View>
              <Text style={[styles.introLabel, { color: stageColor }]}>第 {stageIdx + 1} 关</Text>
              <Text style={[styles.introTitle, { color: colors.foreground }]}>{stage.name}</Text>
              <Text style={[styles.introDesc, { color: colors.mutedForeground }]}>
                {stage.description}
              </Text>
              <View style={[styles.sentenceCountTag, { backgroundColor: colors.muted }]}>
                <Feather name="align-left" size={12} color={colors.mutedForeground} />
                <Text style={[styles.sentenceCountText, { color: colors.mutedForeground }]}>
                  共 {sentences.length} 句，逐句练习
                </Text>
              </View>
              {stage.needsScore && (
                <View style={[styles.thresholdTag, { backgroundColor: colors.muted }]}>
                  <Feather name="target" size={12} color={colors.mutedForeground} />
                  <Text style={[styles.thresholdText, { color: colors.mutedForeground }]}>
                    {STAGE_PASS_SCORE} 分以上即可通关
                  </Text>
                </View>
              )}
              <TouchableOpacity
                onPress={handleBeginPractice}
                style={[styles.startBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.startBtnText}>开始练习</Text>
                <Feather name="arrow-right" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={[styles.textPreview, { backgroundColor: colors.muted }]}>
              <Text style={[styles.textPreviewLabel, { color: colors.mutedForeground }]}>
                练习文章（{sentences.length} 句）
              </Text>
              <Text style={[styles.textPreviewContent, { color: colors.foreground }]} numberOfLines={5}>
                {text.text}
              </Text>
            </View>
          </View>
        )}

        {phase === "memorize" && stageIdx === 3 && (
          <View style={styles.section}>
            <View
              style={[
                styles.countdownCard,
                { backgroundColor: stageColor + "15", borderColor: stageColor + "40", borderWidth: 2 },
              ]}
            >
              <Text style={[styles.countdownNum, { color: stageColor }]}>{memorizeCountdown}</Text>
              <Text style={[styles.countdownLabel, { color: colors.mutedForeground }]}>
                秒后将开始逐句背诵
              </Text>
            </View>
            <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
            </View>
            <Text style={[styles.memorizeHint, { color: colors.mutedForeground }]}>
              请认真记忆文章内容，计时结束后逐句背诵
            </Text>
          </View>
        )}

        {(phase === "practice" || phase === "recording" || phase === "transcribing") && (
          <View style={styles.section}>
            <SpeedControl speed={speed} onChange={setSpeed} color={stageColor} colors={colors} />

            <FullArticleView
              sentences={sentences}
              currentIdx={currentSentIdx}
              sentenceDone={sentenceDone}
              hideText={stageIdx === 2 || stageIdx === 3}
              color={stageColor}
              colors={colors}
              isPlaying={isPlaying}
              onSentencePress={goToSentence}
            />

            <View style={styles.audioRow}>
              <TouchableOpacity
                onPress={currentSentIdx > 0 ? () => goToSentence(currentSentIdx - 1) : undefined}
                disabled={currentSentIdx === 0}
                style={[
                  styles.navIconBtn,
                  { backgroundColor: colors.muted, opacity: currentSentIdx === 0 ? 0.3 : 1 },
                ]}
                activeOpacity={0.7}
              >
                <Feather name="chevron-left" size={20} color={colors.foreground} />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handlePlayCurrentSentence}
                disabled={isPlaying || ttsLoading}
                style={[
                  styles.playBtn,
                  {
                    backgroundColor: sentencePlayed[currentSentIdx] ? colors.muted : stageColor,
                    opacity: isPlaying || ttsLoading ? 0.6 : 1,
                  },
                ]}
                activeOpacity={0.85}
              >
                {ttsLoading ? (
                  <ActivityIndicator
                    color={sentencePlayed[currentSentIdx] ? stageColor : "#fff"}
                    size="small"
                  />
                ) : (
                  <Feather
                    name={isPlaying ? "volume-2" : "play"}
                    size={18}
                    color={sentencePlayed[currentSentIdx] ? stageColor : "#fff"}
                  />
                )}
                <Text
                  style={[
                    styles.playBtnText,
                    { color: sentencePlayed[currentSentIdx] ? stageColor : "#fff" },
                  ]}
                >
                  {ttsLoading
                    ? "加载..."
                    : isPlaying
                    ? `播放第${currentSentIdx + 1}句`
                    : sentencePlayed[currentSentIdx]
                    ? "再听一遍"
                    : `播放第${currentSentIdx + 1}句`}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={
                  currentSentIdx < sentences.length - 1
                    ? () => goToSentence(currentSentIdx + 1)
                    : undefined
                }
                disabled={currentSentIdx >= sentences.length - 1}
                style={[
                  styles.navIconBtn,
                  {
                    backgroundColor: colors.muted,
                    opacity: currentSentIdx >= sentences.length - 1 ? 0.3 : 1,
                  },
                ]}
                activeOpacity={0.7}
              >
                <Feather name="chevron-right" size={20} color={colors.foreground} />
              </TouchableOpacity>
            </View>

            {isPlaying && <AudioWaveform isActive color={stageColor} barCount={7} />}

            {phase === "transcribing" && (
              <View style={[styles.statusRow, { backgroundColor: colors.muted }]}>
                <ActivityIndicator color={stageColor} size="small" />
                <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
                  正在识别语音...
                </Text>
              </View>
            )}

            {sentenceTranscripts[currentSentIdx] && stageIdx !== 2 && phase !== "transcribing" && (
              <View
                style={[
                  styles.transcriptBubble,
                  { backgroundColor: stageColor + "15", borderColor: stageColor + "40" },
                ]}
              >
                <Feather name="check-circle" size={13} color={stageColor} />
                <Text style={[styles.transcriptText, { color: colors.foreground }]} numberOfLines={3}>
                  {sentenceTranscripts[currentSentIdx]}
                </Text>
              </View>
            )}

            {stageIdx === 2 && (
              <>
                <View
                  style={[
                    styles.dictationBox,
                    { backgroundColor: colors.card, borderColor: stageColor },
                  ]}
                >
                  <Text style={[styles.dictationLabel, { color: colors.mutedForeground }]}>
                    第 {currentSentIdx + 1} 句听写内容
                  </Text>
                  <TextInput
                    style={[styles.dictationInput, { color: colors.foreground }]}
                    value={currentInput}
                    onChangeText={setCurrentInput}
                    placeholder="将您听到的内容写在这里..."
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    textAlignVertical="top"
                    autoCorrect={false}
                  />
                </View>
                <TouchableOpacity
                  onPress={handleSaveDictationAndNext}
                  disabled={!currentInput.trim()}
                  style={[
                    styles.nextSentBtn,
                    {
                      backgroundColor: currentInput.trim() ? stageColor : colors.muted,
                      opacity: currentInput.trim() ? 1 : 0.5,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.nextSentBtnText,
                      { color: currentInput.trim() ? "#fff" : colors.mutedForeground },
                    ]}
                  >
                    {currentSentIdx < sentences.length - 1 ? "保存并下一句" : "保存"}
                  </Text>
                  <Feather
                    name={currentSentIdx < sentences.length - 1 ? "arrow-right" : "check"}
                    size={16}
                    color={currentInput.trim() ? "#fff" : colors.mutedForeground}
                  />
                </TouchableOpacity>
              </>
            )}

            {stageIdx !== 2 && stageIdx !== 0 && phase !== "recording" && phase !== "transcribing" && (
              <View style={styles.recordRow}>
                <TouchableOpacity
                  onPress={handleRecord}
                  style={[
                    styles.recordBtn,
                    {
                      backgroundColor: isRecording ? "#EF4444" : stageColor,
                      shadowColor: isRecording ? "#EF4444" : stageColor,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <Feather name={isRecording ? "square" : "mic"} size={28} color="#fff" />
                </TouchableOpacity>
                <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>
                  {isRecording
                    ? "点击停止录音"
                    : sentenceTranscripts[currentSentIdx]
                    ? `重新录第 ${currentSentIdx + 1} 句`
                    : `录第 ${currentSentIdx + 1} 句`}
                </Text>
              </View>
            )}

            {phase === "recording" && (
              <View style={[styles.recordingBanner, { backgroundColor: "#EF4444" + "15" }]}>
                <AudioWaveform isActive color="#EF4444" barCount={9} />
                <TouchableOpacity
                  onPress={handleRecord}
                  style={[styles.recordBtn, { backgroundColor: "#EF4444", shadowColor: "#EF4444" }]}
                  activeOpacity={0.85}
                >
                  <Feather name="square" size={28} color="#fff" />
                </TouchableOpacity>
                <Text style={[styles.recordHint, { color: "#EF4444" }]}>
                  正在录第 {currentSentIdx + 1} 句，点击停止
                </Text>
              </View>
            )}

            {allSentencesDone && stageIdx !== 0 && (
              <TouchableOpacity
                onPress={handleSubmitForScoring}
                style={[styles.submitAllBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Feather name="send" size={18} color="#fff" />
                <Text style={styles.submitAllBtnText}>提交评分</Text>
              </TouchableOpacity>
            )}

            {allSentencesDone && stageIdx === 0 && (
              <TouchableOpacity
                onPress={handleCompleteListening}
                style={[styles.submitAllBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Feather name="check-circle" size={18} color="#fff" />
                <Text style={styles.submitAllBtnText}>完成精听，进入下一关</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {phase === "scoring" && (
          <View style={[styles.section, styles.centerSection]}>
            <ActivityIndicator size="large" color={stageColor} />
            <Text style={[styles.statusText, { color: colors.mutedForeground }]}>AI 评分中...</Text>
          </View>
        )}

        {phase === "result" && result && (
          <View style={styles.section}>
            {stage.needsScore ? (
              <>
                <View
                  style={[
                    styles.passedBanner,
                    {
                      backgroundColor: result.passed ? "#10B981" + "15" : "#EF4444" + "15",
                      borderColor: result.passed ? "#10B981" : "#EF4444",
                    },
                  ]}
                >
                  <Feather
                    name={result.passed ? "check-circle" : "x-circle"}
                    size={22}
                    color={result.passed ? "#10B981" : "#EF4444"}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.passedTitle, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                      {result.passed ? "通关成功！" : "未达通关分数"}
                    </Text>
                    <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                      {result.passed
                        ? isLastStage
                          ? "恭喜完成全部关卡！"
                          : "继续挑战下一关"
                        : `需要 ${STAGE_PASS_SCORE} 分，再试一次吧`}
                    </Text>
                  </View>
                  <Text style={[styles.passedScore, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                    {result.score}
                  </Text>
                </View>
                <ScoreCard
                  score={result.score}
                  feedback={result.feedback}
                  details={result.details}
                  mode={stage.mode as LearningMode}
                />
              </>
            ) : (
              <View
                style={[
                  styles.passedBanner,
                  { backgroundColor: "#10B981" + "15", borderColor: "#10B981" },
                ]}
              >
                <Feather name="headphones" size={22} color="#10B981" />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.passedTitle, { color: "#10B981" }]}>精听完成！</Text>
                  <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                    已听完全部 {sentences.length} 句，第2关已解锁
                  </Text>
                </View>
              </View>
            )}

            {stageIdx < STAGES.length - 1 && (
              <View style={[styles.nextStageHint, { backgroundColor: colors.muted }]}>
                <Feather name={STAGES[stageIdx + 1].icon as any} size={16} color={STAGES[stageIdx + 1].color} />
                <Text style={[styles.nextStageText, { color: colors.foreground }]}>
                  下一关：{STAGES[stageIdx + 1].name}
                </Text>
              </View>
            )}

            <View style={[styles.originalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.originalLabel, { color: colors.mutedForeground }]}>原文</Text>
              {sentences.map((s, i) => (
                <Text key={i} style={[styles.originalSentence, { color: colors.foreground }]}>
                  <Text style={{ color: stageColor, fontFamily: "Inter_600SemiBold" }}>
                    {i + 1}.{" "}
                  </Text>
                  {s}
                </Text>
              ))}
            </View>

            <View style={styles.resultActions}>
              <TouchableOpacity
                onPress={handleRetry}
                style={[styles.retryBtn, { borderColor: colors.border }]}
                activeOpacity={0.85}
              >
                <Feather name="refresh-cw" size={16} color={colors.mutedForeground} />
                <Text style={[styles.retryBtnText, { color: colors.mutedForeground }]}>再练一次</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => router.back()}
                style={[styles.doneBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.doneBtnText}>
                  {result.passed && !isLastStage ? "进入下一关" : "返回"}
                </Text>
                <Feather
                  name={result.passed && !isLastStage ? "arrow-right" : "check"}
                  size={16}
                  color="#fff"
                />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function FullArticleView({
  sentences,
  currentIdx,
  sentenceDone,
  hideText,
  color,
  colors,
  isPlaying,
  onSentencePress,
}: {
  sentences: string[];
  currentIdx: number;
  sentenceDone: (idx: number) => boolean;
  hideText: boolean;
  color: string;
  colors: any;
  isPlaying: boolean;
  onSentencePress: (idx: number) => void;
}) {
  return (
    <View style={[articleStyles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={articleStyles.header}>
        <Feather name={hideText ? "eye-off" : "file-text"} size={13} color={colors.mutedForeground} />
        <Text style={[articleStyles.headerLabel, { color: colors.mutedForeground }]}>
          {hideText ? "文章（已隐藏，凭听力/记忆作答）" : "完整文章"}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={[articleStyles.headerCount, { color }]}>
          {currentIdx + 1} / {sentences.length}
        </Text>
      </View>

      <View style={articleStyles.body}>
        {sentences.map((s, i) => {
          const isCurrent = i === currentIdx;
          const isDone = sentenceDone(i);
          const wordCount = Math.max(3, Math.min(s.split(/\s+/).filter(Boolean).length, 12));

          return (
            <TouchableOpacity
              key={i}
              onPress={() => onSentencePress(i)}
              activeOpacity={0.7}
              style={[
                articleStyles.sentenceRow,
                {
                  backgroundColor: isCurrent ? color + "1A" : "transparent",
                  borderLeftColor: isCurrent ? color : isDone ? color + "60" : "transparent",
                },
              ]}
            >
              <View
                style={[
                  articleStyles.numBadge,
                  {
                    backgroundColor: isCurrent ? color : isDone ? color + "30" : colors.muted,
                  },
                ]}
              >
                {isDone && !isCurrent ? (
                  <Feather name="check" size={11} color={color} />
                ) : (
                  <Text
                    style={[
                      articleStyles.numText,
                      { color: isCurrent ? "#fff" : colors.mutedForeground },
                    ]}
                  >
                    {i + 1}
                  </Text>
                )}
              </View>

              <View style={{ flex: 1 }}>
                {hideText ? (
                  <View style={articleStyles.blanksRow}>
                    {Array.from({ length: wordCount }).map((_, w) => (
                      <View
                        key={w}
                        style={[
                          articleStyles.blank,
                          {
                            backgroundColor: isCurrent ? color + "40" : colors.border,
                            width: 8 + ((w * 7) % 18),
                          },
                        ]}
                      />
                    ))}
                  </View>
                ) : (
                  <Text
                    style={[
                      articleStyles.sentText,
                      {
                        color: isCurrent
                          ? colors.foreground
                          : isDone
                          ? colors.foreground
                          : colors.mutedForeground,
                        fontFamily: isCurrent ? "Inter_600SemiBold" : "Inter_400Regular",
                      },
                    ]}
                  >
                    {s}
                  </Text>
                )}
              </View>

              {isCurrent && isPlaying && (
                <View style={articleStyles.playingDot}>
                  <Feather name="volume-2" size={14} color={color} />
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function SpeedControl({
  speed,
  onChange,
  color,
  colors,
}: {
  speed: Speed;
  onChange: (s: Speed) => void;
  color: string;
  colors: any;
}) {
  return (
    <View style={[speedStyles.row, { backgroundColor: colors.muted }]}>
      <Feather name="clock" size={13} color={colors.mutedForeground} />
      <Text style={[speedStyles.label, { color: colors.mutedForeground }]}>语速</Text>
      {SPEEDS.map((s) => (
        <TouchableOpacity
          key={s}
          onPress={() => onChange(s)}
          style={[
            speedStyles.btn,
            { backgroundColor: speed === s ? color : "transparent" },
          ]}
          activeOpacity={0.7}
        >
          <Text
            style={[
              speedStyles.btnText,
              { color: speed === s ? "#fff" : colors.mutedForeground },
            ]}
          >
            {s}×
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function SentenceNav({
  current,
  total,
  sentenceDone,
  onPrev,
  onNext,
  color,
  colors,
}: {
  current: number;
  total: number;
  sentenceDone: (idx: number) => boolean;
  onPrev?: () => void;
  onNext?: () => void;
  color: string;
  colors: any;
}) {
  return (
    <View style={navStyles.row}>
      <TouchableOpacity
        onPress={onPrev}
        disabled={!onPrev}
        style={[navStyles.arrow, { opacity: onPrev ? 1 : 0.3 }]}
        activeOpacity={0.7}
      >
        <Feather name="chevron-left" size={22} color={colors.foreground} />
      </TouchableOpacity>

      <View style={navStyles.center}>
        <Text style={[navStyles.counter, { color: colors.foreground }]}>
          第 <Text style={{ color, fontFamily: "Inter_700Bold" }}>{current + 1}</Text> / {total} 句
        </Text>
        {sentenceDone(current) && (
          <View style={[navStyles.doneBadge, { backgroundColor: color + "20" }]}>
            <Feather name="check" size={10} color={color} />
            <Text style={[navStyles.doneText, { color }]}>已完成</Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        onPress={onNext}
        disabled={!onNext}
        style={[navStyles.arrow, { opacity: onNext ? 1 : 0.3 }]}
        activeOpacity={0.7}
      >
        <Feather name="chevron-right" size={22} color={colors.foreground} />
      </TouchableOpacity>
    </View>
  );
}

function SentenceDots({
  sentences,
  currentIdx,
  sentenceDone,
  color,
  colors,
  onDotPress,
}: {
  sentences: string[];
  currentIdx: number;
  sentenceDone: (idx: number) => boolean;
  color: string;
  colors: any;
  onDotPress: (idx: number) => void;
}) {
  return (
    <View style={dotsStyles.row}>
      {sentences.map((_, i) => (
        <TouchableOpacity key={i} onPress={() => onDotPress(i)} activeOpacity={0.7}>
          <View
            style={[
              dotsStyles.dot,
              {
                backgroundColor: sentenceDone(i)
                  ? color
                  : i === currentIdx
                  ? color + "60"
                  : colors.border,
                width: i === currentIdx ? 20 : 8,
              },
            ]}
          />
        </TouchableOpacity>
      ))}
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
    paddingBottom: 8,
  },
  backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerStage: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  headerTitle: { fontSize: 14, fontFamily: "Inter_400Regular", marginTop: 1 },
  progressBar: { height: 3 },
  progressFill: { height: 3, borderRadius: 2 },
  content: { paddingHorizontal: 20, paddingTop: 16, gap: 14 },
  section: { gap: 12 },
  centerSection: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 300,
    gap: 16,
  },
  statusText: { fontSize: 15, fontFamily: "Inter_400Regular" },
  introCard: { borderRadius: 20, padding: 24, alignItems: "center", gap: 10 },
  introBadge: { width: 72, height: 72, borderRadius: 20, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  introLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 1, textTransform: "uppercase" },
  introTitle: { fontSize: 24, fontFamily: "Inter_700Bold" },
  introDesc: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22, textAlign: "center" },
  sentenceCountTag: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  sentenceCountText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  thresholdTag: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  thresholdText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  startBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14, marginTop: 6 },
  startBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  textPreview: { borderRadius: 14, padding: 14, gap: 6 },
  textPreviewLabel: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.8 },
  textPreviewContent: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22 },
  textCard: { borderRadius: 16, padding: 16, borderWidth: 1 },
  textContent: { fontSize: 16, fontFamily: "Inter_400Regular", lineHeight: 28 },
  countdownCard: { borderRadius: 16, padding: 24, alignItems: "center", gap: 4 },
  countdownNum: { fontSize: 56, fontFamily: "Inter_700Bold" },
  countdownLabel: { fontSize: 14, fontFamily: "Inter_400Regular" },
  memorizeHint: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  sentenceCard: { borderRadius: 16, padding: 16, gap: 8 },
  hiddenBadge: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  hiddenBadgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  sentenceText: { fontSize: 18, fontFamily: "Inter_500Medium", lineHeight: 30 },
  hiddenSentenceCard: { borderRadius: 14, padding: 20, alignItems: "center", gap: 6 },
  hiddenSentenceText: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  hiddenSentenceHint: { fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center" },
  audioRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  navIconBtn: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  playBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14 },
  playBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12 },
  transcriptBubble: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  transcriptText: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  recordRow: { alignItems: "center", gap: 10 },
  recordBtn: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10, elevation: 8 },
  recordHint: { fontSize: 13, fontFamily: "Inter_400Regular" },
  recordingBanner: { alignItems: "center", gap: 12, padding: 20, borderRadius: 16 },
  dictationBox: { borderRadius: 14, borderWidth: 2, padding: 14, gap: 8 },
  dictationLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  dictationInput: { fontSize: 15, fontFamily: "Inter_400Regular", lineHeight: 24, minHeight: 80 },
  nextSentBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14 },
  nextSentBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  submitAllBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 16, borderRadius: 16 },
  submitAllBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_700Bold" },
  passedBanner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 14, borderWidth: 1.5 },
  passedTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  passedSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  passedScore: { fontSize: 32, fontFamily: "Inter_700Bold" },
  nextStageHint: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 10 },
  nextStageText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  originalCard: { borderRadius: 14, padding: 14, borderWidth: 1, gap: 8 },
  originalLabel: { fontSize: 11, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.8 },
  originalSentence: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22 },
  resultActions: { flexDirection: "row", gap: 10 },
  retryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14, paddingHorizontal: 18, borderRadius: 14, borderWidth: 1, flex: 1 },
  retryBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  doneBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 14, flex: 2 },
  doneBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});

const speedStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, padding: 6, borderRadius: 12 },
  label: { fontSize: 12, fontFamily: "Inter_500Medium", marginRight: 2 },
  btn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  btnText: { fontSize: 12, fontFamily: "Inter_700Bold" },
});

const navStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  arrow: { padding: 6 },
  center: { flex: 1, alignItems: "center", gap: 4 },
  counter: { fontSize: 15, fontFamily: "Inter_500Medium" },
  doneBadge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  doneText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});

const dotsStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 4 },
  dot: { height: 8, borderRadius: 4 },
});

const articleStyles = StyleSheet.create({
  container: { borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.06)",
  },
  headerLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  headerCount: { fontSize: 13, fontFamily: "Inter_700Bold" },
  body: { paddingVertical: 6 },
  sentenceRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderLeftWidth: 3,
  },
  numBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  numText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  sentText: { fontSize: 16, lineHeight: 26 },
  blanksRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
    paddingVertical: 6,
  },
  blank: { height: 10, borderRadius: 5, minWidth: 14 },
  playingDot: { paddingTop: 4 },
});
