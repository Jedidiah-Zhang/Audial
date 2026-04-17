import React, { useState, useEffect, useRef, useCallback } from "react";
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
import type { LearningMode, SessionResult } from "@/types";
import { MODE_LABELS } from "@/types";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

type SessionPhase =
  | "intro"
  | "study"
  | "listening"
  | "recording"
  | "transcribing"
  | "scoring"
  | "result";

export default function SessionScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id, mode } = useLocalSearchParams<{ id: string; mode: LearningMode }>();
  const { texts, addResult, settings } = useApp();
  const { playTTS, stop, isPlaying, isLoading: ttsLoading } = useAudioPlayer();
  const { startRecording, stopRecording, isRecording, hasPermission } = useAudioRecorder();

  const text = texts.find((t) => t.id === id);
  const [phase, setPhase] = useState<SessionPhase>("intro");
  const [dictationInput, setDictationInput] = useState("");
  const [result, setResult] = useState<{ score: number; feedback: string; details: Record<string, string | number> } | null>(null);
  const [isScoring, setIsScoring] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [memorizeCountdown, setMemorizeCountdown] = useState(30);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  const modeLabel = mode ? MODE_LABELS[mode] : "";

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      stop();
    };
  }, []);

  const handlePlayAudio = useCallback(async () => {
    if (!text) return;
    await playTTS(text.text, settings.preferredVoice);
  }, [text, playTTS, settings.preferredVoice]);

  const handleStartStudy = () => {
    setPhase("study");
    if (settings.autoPlayAudio) {
      setTimeout(() => handlePlayAudio(), 500);
    }
  };

  const handleStartRecitation = () => {
    setPhase("study");
    setShowFullText(true);
    setMemorizeCountdown(30);
    countdownRef.current = setInterval(() => {
      setMemorizeCountdown((n) => {
        if (n <= 1) {
          clearInterval(countdownRef.current!);
          setShowFullText(false);
          setPhase("listening");
          return 0;
        }
        return n - 1;
      });
    }, 1000);
  };

  const handleRecord = async () => {
    if (isRecording) {
      setPhase("transcribing");
      const blob = await stopRecording();
      if (!blob) {
        setPhase("listening");
        return;
      }

      try {
        const transcript = await transcribeAudio(blob);
        await scoreAnswer(transcript);
      } catch {
        Alert.alert("错误", "录音转文字失败，请重试");
        setPhase("listening");
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

  const scoreAnswer = async (transcribedOrTyped: string) => {
    if (!text) return;
    setPhase("scoring");
    setIsScoring(true);

    try {
      const endpoint =
        mode === "shadowing"
          ? "/api/language/score-pronunciation"
          : mode === "dictation"
          ? "/api/language/score-dictation"
          : "/api/language/score-recitation";

      const body =
        mode === "dictation"
          ? { targetText: text.text, userText: transcribedOrTyped, language: "中文" }
          : { targetText: text.text, transcribedText: transcribedOrTyped, language: "中文" };

      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await response.json() as { success: boolean; data: any };
      if (!json.success) throw new Error("Scoring failed");

      const d = json.data;
      const details: Record<string, string | number> = {};

      if (mode === "shadowing" && d.mistakes?.length) {
        details["错误词"] = d.mistakes.join(", ");
      }
      if (mode === "dictation" && d.wordAccuracy) {
        details["词汇准确率"] = `${d.wordAccuracy}%`;
      }
      if (mode === "recitation") {
        details["覆盖率"] = `${d.completeness ?? 0}%`;
        details["流畅度"] = { excellent: "优秀", good: "良好", fair: "一般", needs_work: "需加强" }[d.fluency as string] ?? d.fluency;
      }

      const sessionResult: SessionResult = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
        textId: text.id,
        mode,
        score: d.score ?? 0,
        feedback: d.feedback ?? "",
        createdAt: Date.now(),
        details,
      };

      await addResult(sessionResult);

      setResult({ score: d.score ?? 0, feedback: d.feedback ?? "", details });
      Haptics.notificationAsync(
        d.score >= 80
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning
      );
      setPhase("result");
    } catch {
      Alert.alert("评分失败", "无法连接服务器，请检查网络");
      setPhase("listening");
    } finally {
      setIsScoring(false);
    }
  };

  const handleDictationSubmit = async () => {
    if (!dictationInput.trim()) {
      Alert.alert("提示", "请先输入您听到的内容");
      return;
    }
    await scoreAnswer(dictationInput.trim());
  };

  const handleRetry = () => {
    setResult(null);
    setDictationInput("");
    setPhase("intro");
  };

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>文章未找到</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerMode, { color: colors.primary }]}>{modeLabel}</Text>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {text.title}
          </Text>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {phase === "intro" && (
          <View style={styles.section}>
            <View style={[styles.introCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name={mode === "shadowing" ? "mic" : mode === "dictation" ? "edit-2" : "award"} size={40} color={colors.primary} />
              <Text style={[styles.introTitle, { color: colors.foreground }]}>{modeLabel}练习</Text>
              <Text style={[styles.introDesc, { color: colors.mutedForeground }]}>
                {mode === "shadowing" && "您将听到一段母语者朗读的音频，然后模仿跟读。AI 将评估您的发音和准确度。"}
                {mode === "dictation" && "您将听到一段音频，将听到的内容用文字记录下来。可以反复收听。"}
                {mode === "recitation" && "您有 30 秒时间记忆文章，然后背诵。AI 将评估您的背诵质量。"}
              </Text>
              <TouchableOpacity
                onPress={mode === "recitation" ? handleStartRecitation : handleStartStudy}
                style={[styles.startBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.85}
              >
                <Text style={styles.startBtnText}>开始练习</Text>
                <Feather name="arrow-right" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={[styles.textPreview, { backgroundColor: colors.muted }]}>
              <Text style={[styles.textPreviewLabel, { color: colors.mutedForeground }]}>练习文章</Text>
              <Text style={[styles.textPreviewContent, { color: colors.foreground }]} numberOfLines={4}>
                {text.text}
              </Text>
            </View>
          </View>
        )}

        {phase === "study" && mode !== "recitation" && (
          <View style={styles.section}>
            <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
            </View>

            <View style={styles.audioControls}>
              <TouchableOpacity
                onPress={handlePlayAudio}
                disabled={isPlaying || ttsLoading}
                style={[styles.audioBtn, { backgroundColor: colors.primary, opacity: isPlaying || ttsLoading ? 0.6 : 1 }]}
                activeOpacity={0.85}
              >
                {ttsLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Feather name={isPlaying ? "volume-2" : "play"} size={22} color="#fff" />
                )}
                <Text style={styles.audioBtnText}>
                  {ttsLoading ? "加载中..." : isPlaying ? "播放中..." : "播放音频"}
                </Text>
              </TouchableOpacity>

              {isPlaying && <AudioWaveform isActive={isPlaying} color={colors.primary} />}
            </View>

            <TouchableOpacity
              onPress={() => setPhase("listening")}
              style={[styles.nextBtn, { borderColor: colors.primary }]}
              activeOpacity={0.85}
            >
              <Text style={[styles.nextBtnText, { color: colors.primary }]}>
                {mode === "shadowing" ? "准备好了，开始跟读" : "准备好了，开始听写"}
              </Text>
              <Feather name="arrow-right" size={18} color={colors.primary} />
            </TouchableOpacity>
          </View>
        )}

        {phase === "study" && mode === "recitation" && (
          <View style={styles.section}>
            <View style={[styles.countdownCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.countdownNum, { color: colors.primary }]}>{memorizeCountdown}</Text>
              <Text style={[styles.countdownLabel, { color: colors.mutedForeground }]}>秒后隐藏文章</Text>
            </View>
            <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
            </View>
          </View>
        )}

        {phase === "listening" && mode !== "dictation" && (
          <View style={styles.section}>
            {mode === "recitation" && (
              <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
                <Feather name="eye-off" size={24} color={colors.mutedForeground} />
                <Text style={[styles.hiddenText, { color: colors.mutedForeground }]}>文章已隐藏，从记忆中背诵</Text>
              </View>
            )}

            {mode === "shadowing" && (
              <>
                <View style={[styles.textCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={[styles.textContent, { color: colors.foreground }]}>{text.text}</Text>
                </View>
                <TouchableOpacity
                  onPress={handlePlayAudio}
                  disabled={isPlaying || ttsLoading}
                  style={[styles.audioBtn, { backgroundColor: colors.secondary, opacity: isPlaying || ttsLoading ? 0.6 : 1 }]}
                  activeOpacity={0.85}
                >
                  <Feather name="volume-2" size={18} color={colors.primary} />
                  <Text style={[styles.audioBtnText, { color: colors.primary }]}>
                    {isPlaying ? "播放中..." : "再次收听"}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            <View style={styles.recordSection}>
              <TouchableOpacity
                onPress={handleRecord}
                style={[
                  styles.recordBtn,
                  {
                    backgroundColor: isRecording ? colors.destructive : colors.primary,
                    shadowColor: isRecording ? colors.destructive : colors.primary,
                  },
                ]}
                activeOpacity={0.85}
              >
                <Feather name={isRecording ? "square" : "mic"} size={32} color="#fff" />
              </TouchableOpacity>
              <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>
                {isRecording ? "点击停止录音" : "点击开始录音"}
              </Text>
              {isRecording && <AudioWaveform isActive color={colors.destructive} />}
            </View>
          </View>
        )}

        {phase === "listening" && mode === "dictation" && (
          <View style={styles.section}>
            <View style={styles.audioControls}>
              <TouchableOpacity
                onPress={handlePlayAudio}
                disabled={isPlaying || ttsLoading}
                style={[styles.audioBtn, { backgroundColor: colors.primary, opacity: isPlaying || ttsLoading ? 0.6 : 1 }]}
                activeOpacity={0.85}
              >
                {ttsLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Feather name="volume-2" size={20} color="#fff" />
                )}
                <Text style={styles.audioBtnText}>
                  {ttsLoading ? "加载中..." : isPlaying ? "播放中..." : "播放音频"}
                </Text>
              </TouchableOpacity>
              {isPlaying && <AudioWaveform isActive={isPlaying} color={colors.primary} />}
            </View>

            <View style={[styles.dictationBox, { backgroundColor: colors.card, borderColor: colors.primary }]}>
              <Text style={[styles.dictationLabel, { color: colors.mutedForeground }]}>听写内容</Text>
              <TextInput
                style={[styles.dictationInput, { color: colors.foreground }]}
                value={dictationInput}
                onChangeText={setDictationInput}
                placeholder="将您听到的内容写在这里..."
                placeholderTextColor={colors.mutedForeground}
                multiline
                textAlignVertical="top"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              onPress={handleDictationSubmit}
              disabled={!dictationInput.trim()}
              style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: dictationInput.trim() ? 1 : 0.4 }]}
              activeOpacity={0.85}
            >
              <Feather name="check" size={20} color="#fff" />
              <Text style={styles.submitBtnText}>提交答案</Text>
            </TouchableOpacity>
          </View>
        )}

        {(phase === "recording" || phase === "transcribing" || phase === "scoring") && (
          <View style={[styles.section, styles.centerSection]}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
              {phase === "recording" ? "录音中..." : phase === "transcribing" ? "正在转录语音..." : "AI 评分中..."}
            </Text>
          </View>
        )}

        {phase === "result" && result && (
          <View style={styles.section}>
            <ScoreCard
              score={result.score}
              feedback={result.feedback}
              details={result.details}
              mode={mode}
            />

            <View style={[styles.originalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.originalLabel, { color: colors.mutedForeground }]}>原文</Text>
              <Text style={[styles.originalText, { color: colors.foreground }]}>{text.text}</Text>
            </View>

            <View style={styles.resultActions}>
              <TouchableOpacity
                onPress={handleRetry}
                style={[styles.retryBtn, { borderColor: colors.primary }]}
                activeOpacity={0.85}
              >
                <Feather name="refresh-cw" size={16} color={colors.primary} />
                <Text style={[styles.retryBtnText, { color: colors.primary }]}>再练一次</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => router.back()}
                style={[styles.doneBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.85}
              >
                <Text style={styles.doneBtnText}>完成</Text>
                <Feather name="check" size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
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
    paddingBottom: 8,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerMode: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  headerTitle: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  content: {
    paddingHorizontal: 20,
    gap: 16,
  },
  section: {
    gap: 14,
  },
  centerSection: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 300,
    gap: 16,
  },
  statusText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
  },
  introCard: {
    borderRadius: 20,
    padding: 28,
    alignItems: "center",
    borderWidth: 1,
    gap: 12,
  },
  introTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },
  introDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    textAlign: "center",
  },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 4,
  },
  startBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  textPreview: {
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  textPreviewLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  textPreviewContent: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  textCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
  },
  textContent: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 28,
  },
  audioControls: {
    gap: 10,
    alignItems: "center",
  },
  audioBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    width: "100%",
  },
  audioBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 2,
  },
  nextBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  recordSection: {
    alignItems: "center",
    gap: 16,
    paddingVertical: 20,
  },
  recordBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  recordHint: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  dictationBox: {
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
    gap: 8,
  },
  dictationLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  dictationInput: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 26,
    minHeight: 120,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 14,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  countdownCard: {
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    alignItems: "center",
    gap: 4,
  },
  countdownNum: {
    fontSize: 48,
    fontFamily: "Inter_700Bold",
  },
  countdownLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  hiddenCard: {
    borderRadius: 14,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  hiddenText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  originalCard: {
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    gap: 6,
  },
  originalLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  originalText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  resultActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  retryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 2,
  },
  retryBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  doneBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  doneBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
