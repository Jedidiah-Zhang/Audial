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
  Modal,
  BackHandler,
  KeyboardAvoidingView,
  useWindowDimensions,
} from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { ArrowLeft, ArrowRight, BookOpen, Check, EyeOff, Headphones, Lightbulb, RefreshCw, Sparkles, Square, Target, Volume2 } from "lucide-react-native";
import { flipIfRTL, rtlTextStyle } from "@/utils/rtl";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useAudioRecorder, transcribeAudio, useAudioPlayer } from "@/hooks/useAudio";
import { useLiveTranscript } from "@/hooks/useLiveTranscript";
import { useMicPermissionGate } from "@/components/MicPermissionPrompt";
import { AudioWaveform } from "@/components/AudioWaveform";
import { ScoreCard, type PerSentenceRow } from "@/components/ScoreCard";
import { SentenceArticle } from "@/components/SentenceArticle";
import { ShadowSentenceFlow, type ShadowFlowResult } from "@/components/ShadowSentenceFlow";
import { RecitePrepFlow } from "@/components/RecitePrepFlow";
import { AnnotatedText, AnnotatedLegend, type Annotation } from "@/components/AnnotatedText";
import { StageCard } from "@/components/StageCard";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import type { LearningMode } from "@/types";
import { useT, getStageName, getStageDesc } from "@/utils/i18n";
import { Icon } from "@/components/Icon";
import { sanitizeAnnotations } from "@/utils/annotations";
import { useRewardedAd } from "@/hooks/useRewardedAd";
import {
  isShadowLeaveIntercepted,
  setSessionCloseRunner,
} from "@/utils/sessionLeaveIntercept";
import { useDictationHintQuota } from "@/hooks/useDictationHintQuota";
import { buildDictationHintMask } from "@/utils/dictationHint";
import { buildRecitationHintPlan } from "@/utils/recitationHint";
import { buildScoreTips, type ScoreTipsInput } from "@/utils/scoreTips";

/**
 * Compute how many seconds the user gets to memorise a passage in
 * stage 2 (recitation). Scales with passage length so short sentences
 * don't drag and long passages don't feel impossible.
 *
 * Strategy: count "tokens" — words for whitespace languages, characters
 * for CJK / no-space scripts (where word boundaries don't exist) — and
 * map to seconds with a base + per-token slope, clamped to a sensible
 * range so the UI countdown never feels broken.
 */
function computeMemorizeDuration(rawText: string): number {
  const trimmed = (rawText ?? "").trim();
  if (!trimmed) return 30;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const chars = Array.from(trimmed).length;
  // For space-separated text, words is reliable. For CJK / scripts
  // without spaces, the whole passage often collapses to a single
  // "word", so derive units from char count instead (approx 2 chars
  // per memorisable unit).
  const units = words > 1 ? words : Math.max(1, Math.round(chars / 2));
  const seconds = Math.round(8 + units * 1.2);
  return Math.min(120, Math.max(15, seconds));
}

/**
 * Score deduction applied per hint use in the dictation stage. Floored
 * at 0; persisted into the result `details` so the user can see the
 * impact on their final score.
 */
const HINT_SCORE_DEDUCTION_PER_USE = 10;
const HINT_FREE_PER_DAY = 3;
const HINT_AD_BONUS = 3;
/**
 * Whole-passage plays allowed per dictation session. Per-session only —
 * not persisted across app restarts. See `dictationPlaysRemaining`.
 */
const DICTATION_MAX_PLAYS = 3;

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

// Card-expand animation tuning. Kept in sync with app/practice.tsx so
// home → practice → session feels like one continuous transition.
const OPEN_DURATION = 420;
const CLOSE_DURATION = 320;
const OPEN_EASING = Easing.bezier(0.16, 1, 0.3, 1);
const CLOSE_EASING = Easing.bezier(0.4, 0, 0.2, 1);

type Geom = { x: number; y: number; width: number; height: number; radius: number };

function parseGeom(p: {
  oX?: string;
  oY?: string;
  oW?: string;
  oH?: string;
  oR?: string;
}): Geom | null {
  const x = Number(p.oX);
  const y = Number(p.oY);
  const w = Number(p.oW);
  const h = Number(p.oH);
  const r = Number(p.oR ?? "18");
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return null;
  }
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h, radius: Number.isFinite(r) ? r : 18 };
}

type SessionPhase =
  | "intro"
  | "study"
  | "recite-prep"
  | "memorize"
  | "recording"
  | "transcribing"
  | "scoring"
  | "result";

export default function SessionScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const params = useLocalSearchParams<{
    id: string;
    stage: string;
    oX?: string;
    oY?: string;
    oW?: string;
    oH?: string;
    oR?: string;
  }>();
  const { id, stage: stageParam } = params;
  const navigation = useNavigation();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const {
    texts,
    addResult,
    settings,
    userId,
    isPro,
    isAnalysisUnlocked,
    unlockAnalysis,
    getProgressForText,
  } = useApp();
  // Rewarded-ad hooks for the two in-session placements: per-result
  // analysis unlock and dictation hints. `useRewardedAd` is
  // placement-keyed so each call gets its own load/show lifecycle.
  const { show: showAnalysisAd } = useRewardedAd("analysis_unlock");
  const { show: showHintAd } = useRewardedAd("dictation_hint");
  const { show: showRecitationHintAd } = useRewardedAd("recitation_hint");
  const hintQuota = useDictationHintQuota({
    freeHintsPerDay: HINT_FREE_PER_DAY,
    bonusHints: HINT_AD_BONUS,
  });
  const [analysisUnlocking, setAnalysisUnlocking] = useState(false);
  // Active "out of hints today" prompt — surfaced when the user taps
  // the hint button after exhausting today's quota.
  const [hintAdPrompt, setHintAdPrompt] = useState<boolean>(false);
  const [hintAdInFlight, setHintAdInFlight] = useState(false);
  // How many hints have been used in the current dictation attempt.
  // Reset on retry so retries get a clean slate, but each individual
  // use still draws from the daily quota.
  const [hintsUsedThisAttempt, setHintsUsedThisAttempt] = useState(0);
  // Whether the masked-text card is currently shown. Tapping the
  // button while shown hides the card (no quota consumption); tapping
  // while hidden either reveals the existing hints (no consumption,
  // when the user has already paid for at least one) or consumes a
  // fresh hint and reveals more (when not at the per-sentence cap).
  // Auto-collapses on submit and on retry.
  const [hintVisible, setHintVisible] = useState(false);
  const {
    startRecording,
    stopRecording,
    isRecording,
    permission: micPermission,
    requestPermission: requestMicPermission,
    openAppSettings: openMicAppSettings,
    lastRecordingUri,
  } = useAudioRecorder();
  const { requestAccess: requestMicAccess, modal: micPermissionModal } =
    useMicPermissionGate({
      permission: micPermission,
      requestPermission: requestMicPermission,
      openAppSettings: openMicAppSettings,
    });
  // Live (interim + final) transcript that runs alongside the
  // recitation recorder. Best-effort by design: see useLiveTranscript
  // for the failure / fallback contract. Never used for scoring — the
  // authoritative score comes from Whisper after stopRecording.
  const liveTranscript = useLiveTranscript();
  const lang = settings.nativeLanguage;

  const stageIdx = parseInt(stageParam ?? "0", 10);
  const stage = STAGES[stageIdx] ?? STAGES[0];
  const text = texts.find((x) => x.id === id);

  const [phase, setPhase] = useState<SessionPhase>("intro");
  const [dictationInput, setDictationInput] = useState("");
  // Per-dictation-session whole-passage play counter. Starts full at
  // the beginning of each dictation session and decrements on every
  // tap of the Play All button that actually starts playback. Once it
  // hits 0 the button is disabled. Reset on retry, on phase exit from
  // study, and whenever the article or stage changes.
  const [dictationPlaysRemaining, setDictationPlaysRemaining] =
    useState<number>(DICTATION_MAX_PLAYS);
  const [result, setResult] = useState<{
    score: number;
    feedback: string;
    details: Record<string, string | number>;
    passed: boolean;
    targetAnnotations?: Annotation[];
    userAnnotations?: Annotation[];
    userTranscript?: string;
    // perSentence is only used by recitation (stage 2) — shadowing (stage 0)
    // is now a single passage-level score, dictation (stage 1) is one
    // submission, so neither populates this.
    perSentence?: PerSentenceRow[];
    // Typed numeric metrics fed to `buildScoreTips` for the result-page
    // improvement-tips block. Kept separate from `details` (which is
    // pre-stringified for direct rendering) so the tips utility can
    // reason about thresholds without having to parse "85%" back out.
    metrics?: ScoreTipsInput["metrics"];
  } | null>(null);
  // Initialise the countdown from the (possibly missing) text length so
  // the very first render of the countdown card already shows the
  // right number — see `computeMemorizeDuration` for the formula.
  const [memorizeCountdown, setMemorizeCountdown] = useState<number>(() =>
    computeMemorizeDuration(text?.text ?? "")
  );
  // How many recitation hint *steps* the user has consumed in the
  // current attempt. Each step reveals one more "chunk" of keywords
  // (the keyword count per step is decided by `buildRecitationHintPlan`
  // based on passage length so short texts don't get spoiled in one
  // tap and long texts still get meaningful help). Revealed keywords
  // appear in passage order; the rest of the passage renders as
  // placeholders so the learner can see structure but not the full
  // text. Reset on retry / continue / leaving the recitation flow.
  const [recitationHintsRevealed, setRecitationHintsRevealed] =
    useState<number>(0);
  // Whether the "watch ad to reveal hint" prompt is currently open
  // for the recitation stage. Only shown for free-tier users — Pro
  // users get hints immediately without the prompt.
  const [recitationHintAdPrompt, setRecitationHintAdPrompt] =
    useState<boolean>(false);
  const [recitationHintAdInFlight, setRecitationHintAdInFlight] =
    useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stage 0 (shadow) owns its own recorder inside ShadowSentenceFlow, so
  // its recording URI can't be read off the session-level useAudioRecorder.
  // We capture it from the flow's onComplete payload and use it for the
  // "Play my recording" button on the result page.
  const [shadowRecordingUri, setShadowRecordingUri] = useState<string | null>(
    null
  );

  // Result-page word player: lets users tap a wrong/missed token to hear it.
  // We keep one player instance and a single "active word" pointer that
  // identifies both the side ("target" | "user") and the index, so tapping the
  // same word again stops it and tapping a different one interrupts cleanly.
  const wordPlayer = useAudioPlayer({ articleId: text?.id, userId });
  const [activeWord, setActiveWord] = useState<{
    side: "target" | "user";
    index: number;
  } | null>(null);
  const activeWordRef = useRef<{ side: "target" | "user"; index: number } | null>(
    null
  );
  activeWordRef.current = activeWord;

  // Result-page sentence player: lets users tap a failed sentence row in the
  // per-sentence breakdown to hear the model TTS read it again. Kept separate
  // from `wordPlayer` so the two playback contexts don't fight over a shared
  // active pointer.
  const sentencePlayer = useAudioPlayer({ articleId: text?.id, userId });
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number | null>(
    null
  );
  const activeSentenceIndexRef = useRef<number | null>(null);
  activeSentenceIndexRef.current = activeSentenceIndex;

  // Result-page recording player: replays the user's own recitation audio so
  // they can compare it directly against the model's pronunciation. Kept on
  // its own player instance so word / sentence taps don't share isPlaying
  // state with it; we explicitly stop the others before kicking it off.
  const recordingPlayer = useAudioPlayer({ articleId: text?.id, userId });
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);

  const handleWordPress = (side: "target" | "user") => (
    spoken: string,
    index: number
  ) => {
    const trimmed = spoken.trim();
    if (!trimmed) return;
    const cur = activeWordRef.current;
    // Tapping the currently-playing word stops playback.
    if (cur && cur.side === side && cur.index === index) {
      wordPlayer.stop();
      setActiveWord(null);
      return;
    }
    // Stop any concurrent playback (sentence row or user recording) so we
    // never have two voices overlapping on the result page.
    sentencePlayer.stop();
    setActiveSentenceIndex(null);
    recordingPlayer.stop();
    setIsPlayingRecording(false);
    setActiveWord({ side, index });
    const voice = settings.preferredVoice ?? "nova";
    wordPlayer.playTTS(trimmed, voice, () => {
      // Only clear if we're still the active word (hasn't been preempted).
      const after = activeWordRef.current;
      if (after && after.side === side && after.index === index) {
        setActiveWord(null);
      }
    });
  };

  const handleSentencePress = (row: PerSentenceRow) => {
    const target = row.target?.trim();
    if (!target) return;
    // Tapping the currently-playing sentence stops playback.
    if (activeSentenceIndexRef.current === row.index) {
      sentencePlayer.stop();
      setActiveSentenceIndex(null);
      return;
    }
    wordPlayer.stop();
    setActiveWord(null);
    recordingPlayer.stop();
    setIsPlayingRecording(false);
    setActiveSentenceIndex(row.index);
    const voice = settings.preferredVoice ?? "nova";
    sentencePlayer.playTTS(target, voice, () => {
      if (activeSentenceIndexRef.current === row.index) {
        setActiveSentenceIndex(null);
      }
    });
  };

  // Replay the user's own recording from the recitation stage. Stops any
  // other result-page playback first so the model TTS and the user's voice
  // never overlap. Tapping while the recording is already playing toggles
  // it off (matches the behavior of the word / sentence taps above).
  // Pick the right recording URI for the current stage. Stage 0 (shadow)
  // is recorded inside ShadowSentenceFlow on its own recorder hook, so
  // its URI gets piped through `shadowRecordingUri`. Stage 2 (recitation)
  // uses the session-level recorder, exposing it as `lastRecordingUri`.
  const activeRecordingUri = stageIdx === 0 ? shadowRecordingUri : lastRecordingUri;
  const handlePlayMyRecording = () => {
    if (!activeRecordingUri) return;
    if (isPlayingRecording) {
      recordingPlayer.stop();
      setIsPlayingRecording(false);
      return;
    }
    wordPlayer.stop();
    setActiveWord(null);
    sentencePlayer.stop();
    setActiveSentenceIndex(null);
    setIsPlayingRecording(true);
    recordingPlayer.playRecording(activeRecordingUri, () => {
      setIsPlayingRecording(false);
    });
  };

  // Stop word/sentence/recording playback and clear highlights whenever we
  // leave the result phase (e.g. user taps Try Again or Continue) so
  // nothing keeps playing in the background.
  useEffect(() => {
    if (phase !== "result") {
      wordPlayer.stop();
      setActiveWord(null);
      sentencePlayer.stop();
      setActiveSentenceIndex(null);
      recordingPlayer.stop();
      setIsPlayingRecording(false);
    }
  }, [phase, wordPlayer, sentencePlayer, recordingPlayer]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  // Kick off the memorize countdown for stage 2. Factored out so the
  // recite-prep flow can hand control here when the user taps "Start
  // full recitation" — the per-sentence prep is a warm-up only, the
  // existing memorize → hidden-text recording → scoring path is still
  // the single source of truth for the scored take.
  const startMemorizeCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setPhase("memorize");
    setMemorizeCountdown(computeMemorizeDuration(text?.text ?? ""));
    countdownRef.current = setInterval(() => {
      setMemorizeCountdown((n) => {
        if (n <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
          }
          setPhase("study");
          return 0;
        }
        return n - 1;
      });
    }, 1000);
  }, [text?.text]);

  const handleBeginPractice = () => {
    if (stageIdx === 2) {
      // Stage 2 (recitation) now starts with a per-sentence prep loop
      // that mirrors the shadowing warm-up. The CTA inside the prep
      // component invokes startMemorizeCountdown to enter the existing
      // memorize phase, so the scored take itself is unchanged.
      setPhase("recite-prep");
    } else {
      setPhase("study");
    }
  };

  const handleRecord = async () => {
    if (isRecording) {
      // Stop the live recognizer first; failures here must NEVER block
      // the audio recorder stop / Whisper transcription. The recognizer
      // is a UI preview only.
      try {
        liveTranscript.stop();
      } catch {
        /* ignore — best effort */
      }
      setPhase("transcribing");
      const blob = await stopRecording();
      if (!blob) {
        setPhase("study");
        return;
      }
      if (!text) {
        setPhase("study");
        return;
      }
      try {
        const transcript = await transcribeAudio(blob, undefined, text.targetLanguage);
        await scoreAnswer(transcript);
      } catch {
        Alert.alert(t("common.error"), t("session.alert.transcribeFailed"));
        setPhase("study");
      }
    } else {
      // Gate on mic permission. If it's not yet granted, the gate opens the
      // in-app explainer modal and replays this start-recording closure the
      // moment the user grants — no second tap on the mic required.
      requestMicAccess(async () => {
        const started = await startRecording();
        if (!started) return;
        setPhase("recording");
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        // Kick the live recognizer off in parallel with the recorder.
        // Wrapped in a try/catch + fire-and-forget: any failure
        // silently flips the hook's `isLiveTranscriptAvailable` to
        // false (so the UI shows the "unavailable" notice) but never
        // blocks or rolls back the recording itself.
        if (text?.targetLanguage) {
          liveTranscript.reset();
          void liveTranscript
            .start(text.targetLanguage)
            .catch(() => {
              /* swallow — hook already mirrors error into state */
            });
        }
      });
    }
  };

  const scoreAnswer = async (transcribedOrTyped: string, hintsUsed: number = 0) => {
    if (!text) return;
    setPhase("scoring");

    try {
      const mode = stage.mode as LearningMode;
      const endpoint =
        stageIdx === 0
          ? "/api/language/score-pronunciation"
          : stageIdx === 1
          ? "/api/language/score-dictation"
          : "/api/language/score-recitation";

      // `language` controls the language the LLM uses for its written
      // feedback ("用 ${language} 回复"), so it must be the user's UI /
      // native language — not the language being practiced. Passing
      // text.targetLanguage here was the bug that made evaluator
      // comments come back in the learning language. The target
      // language is still implicit in `targetText` itself, so the
      // model has no trouble grading the right content.
      const body =
        stageIdx === 1
          ? { targetText: text.text, userText: transcribedOrTyped, language: settings.nativeLanguage }
          : { targetText: text.text, transcribedText: transcribedOrTyped, language: settings.nativeLanguage };

      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await response.json() as { success: boolean; data: any };
      if (!json.success) throw new Error("Scoring failed");

      const d = json.data;
      const details: Record<string, string | number> = {};

      // For shadowing, the mistakes are now visualised inline via AnnotatedText,
      // so we no longer repeat them as a comma-joined detail row.
      if (stageIdx === 1 && d.wordAccuracy != null) {
        details[t("session.detail.wordAccuracy")] = `${d.wordAccuracy}%`;
      }
      // Surface hint usage in the result details so the user understands
      // why their score may be lower than expected. Only show the row if
      // hints were actually used this attempt.
      const hintDelta =
        stageIdx === 1 ? Math.max(0, hintsUsed) * HINT_SCORE_DEDUCTION_PER_USE : 0;
      if (stageIdx === 1 && hintsUsed > 0) {
        details[t("dictation.hint.detailRow")] = t("dictation.hint.detailValue", {
          count: hintsUsed,
          delta: -hintDelta,
        });
      }
      if (stageIdx === 2) {
        details[t("session.detail.coverage")] = `${d.completeness ?? 0}%`;
        const fluencyKey = `fluency.${d.fluency}`;
        details[t("session.detail.fluency")] = d.fluency ? t(fluencyKey) : "";
      }

      // Apply hint deduction to the raw model score, floored at 0.
      const rawScore = d.score ?? 0;
      const score = Math.max(0, rawScore - hintDelta);
      const passed = score >= STAGE_PASS_SCORE;

      const targetAnnotations = sanitizeAnnotations(d.targetAnnotations, text.text);
      const userAnnotations = sanitizeAnnotations(d.userAnnotations, transcribedOrTyped);
      const userTranscript = transcribedOrTyped;

      const persistedDetails: Record<string, unknown> = { ...details };
      if (targetAnnotations) persistedDetails.targetAnnotations = targetAnnotations;
      if (userAnnotations) persistedDetails.userAnnotations = userAnnotations;
      if (userTranscript) persistedDetails.userTranscript = userTranscript;
      if (stageIdx === 1 && hintsUsed > 0) {
        persistedDetails.hintsUsed = hintsUsed;
        persistedDetails.hintScoreDeduction = hintDelta;
      }

      await addResult({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
        textId: text.id,
        mode: mode as LearningMode,
        stage: stageIdx,
        score,
        feedback: d.feedback ?? "",
        createdAt: Date.now(),
        details: persistedDetails,
      });

      // Capture typed numeric metrics for the improvement-tips block.
      // Stage 1 (dictation) only carries hint info; stage 2 (recitation)
      // surfaces the model's `completeness` percentage as coverage.
      const tipMetrics: ScoreTipsInput["metrics"] = {};
      if (stageIdx === 1) {
        // Dictation surfaces `wordAccuracy` (0-100) as its only
        // numeric sub-score; map it onto the generic `accuracy`
        // dimension so users with a low dictation accuracy still get
        // a severity-based tip rather than the "all good" fallback.
        if (typeof d.wordAccuracy === "number") {
          tipMetrics.accuracy = d.wordAccuracy;
        } else if (typeof d.score === "number") {
          // Older server payloads / fallbacks: derive accuracy from
          // the overall score so the tips block still has at least
          // one dimension to reason about.
          tipMetrics.accuracy = d.score;
        }
        if (hintsUsed > 0) {
          tipMetrics.hintsUsed = hintsUsed;
          tipMetrics.hintScoreDeduction = hintDelta;
        }
      }
      if (stageIdx === 2 && typeof d.completeness === "number") {
        tipMetrics.coverage = d.completeness;
      }

      setResult({
        score,
        feedback: d.feedback ?? "",
        details,
        passed,
        targetAnnotations: targetAnnotations ?? undefined,
        userAnnotations: userAnnotations ?? undefined,
        userTranscript,
        metrics: tipMetrics,
      });
      Haptics.notificationAsync(
        passed ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
      );
      setPhase("result");
    } catch {
      Alert.alert(t("common.error"), t("session.alert.scoreFailed"));
      setPhase("study");
    }
  };

  const handleShadowFlowComplete = async (flow: ShadowFlowResult) => {
    if (!text) return;
    const score = flow.score;
    const passed = score >= STAGE_PASS_SCORE;
    // Stage 0 (shadow) now produces a single passage-level score with two
    // optional sub-scores from the model. We surface them in the same
    // details strip that the other stages use so users get a quick glance
    // at fluency vs accuracy without digging into per-sentence rows.
    const details: Record<string, string | number> = {};
    if (typeof flow.accuracy === "number") {
      details[t("session.detail.accuracy")] = `${flow.accuracy}%`;
    }
    if (typeof flow.confidence === "number") {
      details[t("session.detail.confidence")] = `${flow.confidence}%`;
    }
    if (typeof flow.pace === "number") {
      details[t("session.detail.pace")] = `${flow.pace}%`;
    }
    if (typeof flow.prosody === "number") {
      details[t("session.detail.prosody")] = `${flow.prosody}%`;
    } else if (flow.prosodyAvailable === false) {
      // Surface the missing-signal state explicitly so users don't
      // wonder why prosody dropped out — better than silently hiding
      // it. The "—" is treated as a string, so it renders as a label
      // value rather than a number.
      details[t("session.detail.prosody")] = t("session.detail.unavailable");
    }
    // Keep the legacy "fluency" row for users who still expect it,
    // mapping to the same value as confidence (closest semantic match).
    if (
      typeof flow.fluency === "number" &&
      typeof flow.confidence !== "number"
    ) {
      details[t("session.detail.fluency")] = `${flow.fluency}%`;
    }

    const persistedDetails: Record<string, unknown> = { ...details };
    if (typeof flow.fluency === "number") persistedDetails.fluency = flow.fluency;
    if (typeof flow.accuracy === "number") persistedDetails.accuracy = flow.accuracy;
    if (typeof flow.pace === "number") persistedDetails.pace = flow.pace;
    if (typeof flow.confidence === "number")
      persistedDetails.confidence = flow.confidence;
    if (typeof flow.prosody === "number" || flow.prosody === null)
      persistedDetails.prosody = flow.prosody;
    if (typeof flow.prosodyAvailable === "boolean")
      persistedDetails.prosodyAvailable = flow.prosodyAvailable;
    if (flow.lowConfidenceWords && flow.lowConfidenceWords.length > 0)
      persistedDetails.lowConfidenceWords = flow.lowConfidenceWords;
    if (flow.targetAnnotations) {
      persistedDetails.targetAnnotations = flow.targetAnnotations;
    }
    if (flow.userTranscript) persistedDetails.userTranscript = flow.userTranscript;

    // Persistence is best-effort: even if writing to local storage fails we
    // still want to surface the result page so the user sees their score.
    try {
      await addResult({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
        textId: text.id,
        mode: "shadowing",
        stage: 0,
        score,
        feedback: flow.feedback,
        createdAt: Date.now(),
        details: persistedDetails,
      });
    } catch (err) {
      console.warn("[session] failed to persist shadow result", err);
    }

    setShadowRecordingUri(flow.recordingUri ?? null);
    setResult({
      score,
      feedback: flow.feedback,
      details,
      passed,
      userTranscript: flow.userTranscript || undefined,
      targetAnnotations: flow.targetAnnotations,
      metrics: {
        accuracy: typeof flow.accuracy === "number" ? flow.accuracy : undefined,
        confidence:
          typeof flow.confidence === "number" ? flow.confidence : undefined,
        pace: typeof flow.pace === "number" ? flow.pace : undefined,
        prosody: typeof flow.prosody === "number" ? flow.prosody : undefined,
        prosodyAvailable: flow.prosodyAvailable,
      },
    });
    Haptics.notificationAsync(
      passed ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning
    );
    setPhase("result");
  };

  const handleDictationSubmit = async () => {
    if (!dictationInput.trim()) {
      Alert.alert(t("common.tip"), t("session.alert.dictationEmpty"));
      return;
    }
    // Spec: "提交后收起" — collapse the hint card on submit so the
    // result UI isn't dominated by the masked sentence.
    setHintVisible(false);
    await scoreAnswer(dictationInput.trim(), hintsUsedThisAttempt);
  };

  const handleRetry = () => {
    setResult(null);
    setDictationInput("");
    setShadowRecordingUri(null);
    setHintsUsedThisAttempt(0);
    setHintVisible(false);
    setRecitationHintsRevealed(0);
    setRecitationHintAdPrompt(false);
    // Restarting the dictation session refills the play counter — see
    // task spec: "Starting a new dictation session (new passage /
    // restart) resets the counter to 3."
    setDictationPlaysRemaining(DICTATION_MAX_PLAYS);
    setPhase("intro");
  };

  const handleNextStage = () => {
    router.back();
  };

  // Recitation hint plan: derived from the passage text and the
  // current step count. The plan owns keyword selection, pacing
  // (how many keywords per tap, total taps available), and the
  // masked display string. Recomputing on every step change is cheap
  // and keeps render in sync with state.
  const recitationHintPlan = React.useMemo(
    () => buildRecitationHintPlan(text?.text ?? "", recitationHintsRevealed),
    [text, recitationHintsRevealed]
  );
  const recitationHasKeywords = recitationHintPlan.totalKeywords > 0;
  const recitationHintsAtCap =
    recitationHasKeywords &&
    recitationHintsRevealed >= recitationHintPlan.totalSteps;

  const recitationHintInFlightRef = useRef(false);
  const handleRevealRecitationHint = async () => {
    if (recitationHintInFlightRef.current) return;
    if (recitationHintsAtCap || !recitationHasKeywords) return;
    if (isPro) {
      // Pro users skip the ad and advance one step immediately.
      setRecitationHintsRevealed((n) =>
        Math.min(recitationHintPlan.totalSteps, n + 1)
      );
      return;
    }
    setRecitationHintAdPrompt(true);
  };

  const handleRecitationHintWatchAd = async () => {
    if (recitationHintAdInFlight || recitationHintInFlightRef.current) return;
    recitationHintInFlightRef.current = true;
    setRecitationHintAdInFlight(true);
    try {
      const outcome = await showRecitationHintAd();
      if (outcome === "rewarded") {
        // Re-check the cap inside the resolve in case the user managed
        // to advance past it through some other path while the ad
        // was on screen.
        setRecitationHintsRevealed((n) =>
          recitationHintPlan.totalSteps > 0
            ? Math.min(recitationHintPlan.totalSteps, n + 1)
            : n + 1
        );
        setRecitationHintAdPrompt(false);
      }
      // dismissed / unavailable: leave the prompt open so the user can
      // retry — no hint reveal, no consumption (matches the existing
      // dictation_hint behavior).
    } finally {
      setRecitationHintAdInFlight(false);
      recitationHintInFlightRef.current = false;
    }
  };

  // Reset the revealed-hint state whenever we leave the recitation
  // study/recording flow so a brand-new attempt starts blind. Mirrors
  // the existing playback-cleanup effect above.
  useEffect(() => {
    if (stageIdx !== 2) return;
    if (phase !== "study" && phase !== "recording") {
      setRecitationHintsRevealed(0);
      setRecitationHintAdPrompt(false);
    }
  }, [phase, stageIdx]);

  // Refill the dictation play counter at the start of each fresh
  // dictation session: when the article changes, when the active
  // stage changes, or whenever we step out of the study phase
  // (covers the "back to intro then re-enter" path even though
  // handleRetry also explicitly resets it).
  useEffect(() => {
    if (stageIdx !== 1) return;
    if (phase !== "study") {
      setDictationPlaysRemaining(DICTATION_MAX_PLAYS);
    }
  }, [phase, stageIdx, text?.id]);

  // Hint button handler — three behaviours rolled into one tap:
  //   1. Card is currently shown   → hide it (no quota consumption).
  //   2. Card is hidden but the user already has at least one hint
  //      revealed AND we're at the per-sentence reveal cap → just show
  //      the existing reveal (no quota consumption).
  //   3. Otherwise → consume one hint (or surface the ad prompt if the
  //      daily quota is exhausted) and reveal one more word.
  //
  // Guarded by a ref against double-tap races: the on-screen disabled
  // state is computed from React state which lags by one frame, so
  // a quick double-tap could otherwise consume two quota units while
  // only revealing one new word (and over-deducting the score).
  const hintInFlightRef = useRef(false);
  const handleUseHint = () => {
    if (hintInFlightRef.current) return;
    if (!hintQuota.isReady) return;
    if (!text) return;
    // (1) Toggle-hide path — never consumes.
    if (hintVisible) {
      setHintVisible(false);
      return;
    }
    const { totalHintable } = buildDictationHintMask(text.text, hintsUsedThisAttempt);
    // (2) Reveal-existing path — already paid for hints and at cap.
    // Reshow without spending another hint.
    if (
      hintsUsedThisAttempt > 0 &&
      totalHintable > 0 &&
      hintsUsedThisAttempt >= totalHintable
    ) {
      setHintVisible(true);
      return;
    }
    // (3) Consume + reveal one more.
    hintInFlightRef.current = true;
    try {
      if (!hintQuota.tryConsume()) {
        setHintAdPrompt(true);
        return;
      }
      setHintsUsedThisAttempt((n) => n + 1);
      setHintVisible(true);
    } finally {
      // Release on the next tick so a second synchronous tap (same
      // event loop) can't slip through, but normal subsequent taps
      // remain responsive.
      setTimeout(() => {
        hintInFlightRef.current = false;
      }, 0);
    }
  };

  const handleHintWatchAd = async () => {
    if (hintAdInFlight) return;
    setHintAdInFlight(true);
    try {
      const outcome = await showHintAd();
      if (outcome === "rewarded") {
        hintQuota.grantBonus();
        setHintAdPrompt(false);
      }
      // On dismiss/unavailable: leave the prompt open so the user can
      // retry or upgrade — they get no hints from a half-watched ad.
    } finally {
      setHintAdInFlight(false);
    }
  };

  const handleAnalysisUnlock = async () => {
    // Find the current result's id from AppContext-side history. We use
    // the createdAt timestamp captured at scoring time; the persisted
    // result stored just above carries the same id, but we kept the
    // local `result` state lean. Look it up by mode+stage+createdAt
    // proximity is overkill — instead we encode the unlock by the
    // session-level synthetic key, which collapses to the same per-text
    // unlock surface for the user.
    const resultKey = currentResultKeyRef.current;
    if (!resultKey || analysisUnlocking) return;
    setAnalysisUnlocking(true);
    try {
      const outcome = await showAnalysisAd();
      if (outcome === "rewarded") {
        await unlockAnalysis(resultKey);
      }
    } finally {
      setAnalysisUnlocking(false);
    }
  };

  // Synthetic per-result key used to scope the "analysis unlocked" flag.
  // We can't read the freshly-persisted result id from AppContext here
  // without an extra round-trip, so we mint a deterministic key when the
  // result page is shown and reuse it for the unlock check & the
  // unlockAnalysis call. Refreshes when a new result is set.
  const currentResultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (result) {
      // textId + stage + score is stable across re-renders for a given
      // result and unique enough that two different results from the
      // same article won't collide in normal use.
      currentResultKeyRef.current = `${text?.id ?? "anon"}:${stageIdx}:${result.score}:${(result.userTranscript ?? "").slice(0, 32)}`;
    } else {
      currentResultKeyRef.current = null;
    }
  }, [result, stageIdx, text?.id]);

  // Stage 0 used to gate its per-sentence analysis behind a rewarded ad,
  // but the shadow flow no longer produces per-sentence rows — the result
  // is a single passage-level score with optional fluency / accuracy
  // sub-scores, all of which we show free. No stage currently triggers
  // the gate; we keep the helpers wired up so we can re-enable it for a
  // different stage in the future without re-plumbing.
  const analysisLocked = false;

  // ---- Card-expand transition (mirrors app/practice.tsx) ----
  // The /practice screen captures the tapped stage card's geometry and
  // hands it to us via router params. We replay the same expand-from-
  // card animation here so the practice → session navigation feels like
  // one continuous transition, matching the home → practice animation.
  const initialGeom = useRef(parseGeom(params)).current;
  const hasGeom = initialGeom != null && Platform.OS !== "web";

  const stageColorValue = stage.color;
  const progressForText = text ? getProgressForText(text.id) : undefined;
  const stagePassedArr =
    progressForText?.stagePassed ?? STAGES.map(() => false);
  const snapshotPassed = stagePassedArr[stageIdx] ?? false;
  const snapshotLocked = stageIdx > 0 && !stagePassedArr[stageIdx - 1];
  const snapshotCurrent = !snapshotLocked && !snapshotPassed;
  // Match the originating stage card chrome so the start of the
  // animation lines up exactly with what the user just tapped.
  const overlayBorderColor = snapshotCurrent
    ? stageColorValue
    : snapshotPassed
    ? stageColorValue + "60"
    : colors.border;
  const overlayMaxBorder = snapshotCurrent ? 2 : 1;

  const progressSV = useSharedValue(hasGeom ? 0 : 1);
  // Overlay stays mounted for the lifetime of the screen; see the same
  // rationale in app/practice.tsx (avoids a one-frame flash on Android
  // when tearing down the overlay's view tree at p=1).
  const [overlayMounted] = useState(hasGeom);
  const closingRef = useRef(false);

  // Touch-gate for the session content during the open/close crossfade.
  const [contentPointerEvents, setContentPointerEvents] = useState<
    "auto" | "none"
  >(hasGeom ? "none" : "auto");
  useAnimatedReaction(
    () => progressSV.value >= 0.85,
    (interactive, prev) => {
      if (prev === null || interactive === prev) return;
      runOnJS(setContentPointerEvents)(interactive ? "auto" : "none");
    },
  );

  useEffect(() => {
    if (!hasGeom) return;
    const handle = requestAnimationFrame(() => {
      progressSV.value = withTiming(1, {
        duration: OPEN_DURATION,
        easing: OPEN_EASING,
      });
    });
    return () => cancelAnimationFrame(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCloseAnimation = useCallback(
    (onDone: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;
      progressSV.value = withTiming(
        0,
        { duration: CLOSE_DURATION, easing: CLOSE_EASING },
        (finished) => {
          if (finished) runOnJS(onDone)();
        },
      );
    },
    [progressSV],
  );

  // Intercept navigation back so the reverse animation runs first. This
  // covers the in-app back button, the iOS swipe-back gesture (since
  // navigation events fire for it too), and any router.back() calls
  // emitted from inside the session screen (e.g. handleNextStage).
  //
  // We deliberately do NOT re-dispatch `e.data.action`. In this app the
  // /session screen sits on top of /practice, and both are presented as
  // `transparentModal`. Re-dispatching the original GO_BACK action in
  // that nested-transparent-modal stack can cascade through both modals
  // at once — the user lands on the home article list, completely
  // skipping the article practice page underneath. Forcing an explicit
  // single-step pop keeps the back action scoped to just this screen so
  // we always land on /practice with its expanded state intact.
  useEffect(() => {
    if (!hasGeom) return;
    const sub = navigation.addListener("beforeRemove", (e) => {
      if (closingRef.current) return;
      // A child flow (e.g. ShadowSentenceFlow) may want to show its own
      // confirmation dialog before we play the collapse animation. When
      // it has registered itself as the leave interceptor, we only block
      // the navigation here — the child decides whether to invoke the
      // close runner (after the user confirms) or to abort.
      if (isShadowLeaveIntercepted()) {
        e.preventDefault();
        return;
      }

      const dispatchClose = () => {
        runCloseAnimation(() => {
          // Wait one extra frame before handing control to the navigator;
          // see the same comment in app/practice.tsx for why.
          requestAnimationFrame(() => {
            // Inline POP action (equivalent to StackActions.pop(1) from
            // @react-navigation/native, which expo-router does not re-export).
            navigation.dispatch({ type: "POP", payload: { count: 1 } });
          });
        });
      };

      // Dictation guard: prompt before discarding typed-but-unsubmitted
      // input. Only relevant during the study phase of stage 1 — once
      // submission moves the phase to scoring/result, the input is
      // already captured and there's nothing left to lose.
      const dictationDirty =
        stageIdx === 1 &&
        phase === "study" &&
        dictationInput.trim().length > 0;
      // Recitation guard: prompt while the mic is actively recording.
      // Recordings auto-submit when the user stops them (handleRecord),
      // so "in-progress recording" is the only state that can leak work
      // for stage 2.
      const recitationDirty = stageIdx === 2 && isRecording;

      if (dictationDirty || recitationDirty) {
        e.preventDefault();
        const isRecitation = recitationDirty;
        const titleKey = isRecitation
          ? "session.recitation.leaveTitle"
          : "session.dictation.leaveTitle";
        const bodyKey = isRecitation
          ? "session.recitation.leaveBody"
          : "session.dictation.leaveBody";
        const stayKey = isRecitation
          ? "session.recitation.leaveStay"
          : "session.dictation.leaveStay";
        const discardKey = isRecitation
          ? "session.recitation.leaveDiscard"
          : "session.dictation.leaveDiscard";
        Alert.alert(t(titleKey), t(bodyKey), [
          { text: t(stayKey), style: "cancel" },
          {
            text: t(discardKey),
            style: "destructive",
            onPress: () => {
              // For recitation, tear the active recording down cleanly so
              // we don't leak the mic handle after the screen unmounts.
              // stopRecording resolves with the captured blob which we
              // intentionally discard here.
              if (isRecitation) {
                try {
                  liveTranscript.stop();
                } catch {
                  /* ignore */
                }
                void stopRecording().catch(() => {});
              }
              dispatchClose();
            },
          },
        ]);
        return;
      }

      e.preventDefault();
      dispatchClose();
    });
    return sub;
  }, [
    navigation,
    runCloseAnimation,
    hasGeom,
    stageIdx,
    phase,
    dictationInput,
    isRecording,
    stopRecording,
    liveTranscript,
    t,
  ]);

  // Expose the close-animation runner so child flows can play it after
  // their own confirmation dialog resolves. We always register/unregister
  // together so a stale runner from a previous mount can never fire.
  useEffect(() => {
    setSessionCloseRunner((onDone) => {
      if (!hasGeom) {
        onDone();
        return;
      }
      runCloseAnimation(onDone);
    });
    return () => {
      setSessionCloseRunner(null);
    };
  }, [runCloseAnimation, hasGeom]);

  useEffect(() => {
    if (Platform.OS !== "android" || !hasGeom) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => false);
    return () => sub.remove();
  }, [hasGeom]);

  // See app/practice.tsx for the Android Dialog-vs-activity-window
  // coordinate-space rationale behind this offset.
  const verticalOffset = Platform.OS === "android" ? insets.top : 0;

  const overlayBgStyle = useAnimatedStyle(() => {
    if (!initialGeom) return { opacity: 0 };
    const p = progressSV.value;
    const inv = 1 - p;
    const bgOp = p <= 0.85 ? 1 : Math.max(0, 1 - (p - 0.85) / 0.15);
    return {
      top: (initialGeom.y + verticalOffset) * inv,
      left: initialGeom.x * inv,
      width: initialGeom.width + (screenW - initialGeom.width) * p,
      height: initialGeom.height + (screenH - initialGeom.height) * p,
      borderRadius: initialGeom.radius * inv,
      borderWidth: overlayMaxBorder * inv,
      opacity: bgOp,
    };
  }, [
    initialGeom?.x,
    initialGeom?.y,
    initialGeom?.width,
    initialGeom?.height,
    initialGeom?.radius,
    screenW,
    screenH,
    overlayMaxBorder,
    verticalOffset,
  ]);

  const contentScaleTarget = initialGeom
    ? Math.min(1.6, Math.max(1, screenW / initialGeom.width))
    : 1;
  const contentSnapStyle = useAnimatedStyle(() => {
    if (!initialGeom) return { opacity: 0 };
    const p = progressSV.value;
    const s = 1 + (contentScaleTarget - 1) * p;
    const op = p <= 0.55 ? 1 : p >= 0.9 ? 0 : 1 - (p - 0.55) / 0.35;
    return { transform: [{ scale: s }], opacity: op };
  }, [contentScaleTarget, initialGeom?.width, initialGeom?.height]);

  const contentStyle = useAnimatedStyle(() => {
    const p = progressSV.value;
    const op = p <= 0.4 ? 0 : p >= 0.85 ? 1 : (p - 0.4) / 0.45;
    return { opacity: op };
  });

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>{t("home.notFound")}</Text>
      </View>
    );
  }

  const stageColor = stage.color;
  const isLastStage = stageIdx === STAGES.length - 1;

  return (
    // Container is transparent so the practice screen (rendered behind
    // us via `presentation: "transparentModal"` in app/_layout.tsx)
    // shows through during the card-expand animation. The opaque
    // background lives on `contentWrap` below where it crossfades with
    // the overlay snapshot.
    <View style={[styles.container, { backgroundColor: "transparent" }]}>
      <Animated.View
        pointerEvents={hasGeom ? contentPointerEvents : "auto"}
        style={[
          styles.contentWrap,
          { backgroundColor: colors.background },
          hasGeom ? contentStyle : null,
        ]}
      >
      <View style={[styles.header, { paddingTop: topPad + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} activeOpacity={0.7}>
          <ArrowLeft size={22} color={colors.foreground} style={flipIfRTL()} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerStage, { color: stageColor }]}>
            {t("card.stage", { n: stageIdx + 1, name: getStageName(stageIdx, lang) })}
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
            {
              backgroundColor: stageColor,
              width: `${((stageIdx + 1) / STAGES.length) * 100}%`,
            },
          ]}
        />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? topPad + 12 : 0}
      >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {phase === "intro" && (
          <View style={styles.section}>
            <View style={[styles.introCard, { backgroundColor: colors.card, borderColor: stageColor + "40", borderWidth: 2 }]}>
              <View style={[styles.introBadge, { backgroundColor: stageColor + "20" }]}>
                <Icon name={stage.icon as any} size={36} color={stageColor} />
              </View>
              <Text style={[styles.introLabel, { color: stageColor }]}>
                {t("practice.stageNum", { n: stageIdx + 1 })}
              </Text>
              <Text style={[styles.introTitle, { color: colors.foreground }]}>{getStageName(stageIdx, lang)}</Text>
              <Text style={[styles.introDesc, { color: colors.mutedForeground }]}>
                {getStageDesc(stageIdx, lang)}
              </Text>
              {stage.needsScore && (
                <View style={[styles.thresholdTag, { backgroundColor: colors.muted }]}>
                  <Target size={12} color={colors.mutedForeground} />
                  <Text style={[styles.thresholdText, { color: colors.mutedForeground }]}>
                    {t("session.intro.passRule", { n: STAGE_PASS_SCORE })}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                onPress={handleBeginPractice}
                style={[styles.startBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.startBtnText}>{t("session.intro.start")}</Text>
                <ArrowRight size={18} color="#fff" style={flipIfRTL()} />
              </TouchableOpacity>
            </View>

            <View style={[styles.textPreview, { backgroundColor: colors.muted }]}>
              <Text style={[styles.textPreviewLabel, { color: colors.mutedForeground }]}>{t("session.intro.previewLabel")}</Text>
              <Text style={[styles.textPreviewContent, { color: colors.foreground }, rtlTextStyle(text.text)]} numberOfLines={5}>
                {text.text}
              </Text>
            </View>
          </View>
        )}

        {phase === "recite-prep" && stageIdx === 2 && (
          <View style={styles.section}>
            <RecitePrepFlow
              text={text.text}
              voice={settings.preferredVoice ?? "nova"}
              accentColor={stageColor}
              contentType={text.contentType}
              articleId={text.id}
              onContinue={startMemorizeCountdown}
            />
          </View>
        )}

        {phase === "memorize" && stageIdx === 2 && (
          <View style={styles.section}>
            <View style={[styles.countdownCard, { backgroundColor: stageColor + "15", borderColor: stageColor + "40", borderWidth: 2 }]}>
              <Text style={[styles.countdownNum, { color: stageColor }]}>{memorizeCountdown}</Text>
              <Text style={[styles.countdownLabel, { color: colors.mutedForeground }]}>{t("session.memorize.subtitle")}</Text>
            </View>
            <SentenceArticle
              text={text.text}
              accentColor={stageColor}
              contentType={text.contentType}
              articleId={text.id}
              targetLanguage={text.targetLanguage}
              showPlayAll
            />
            <Text style={[styles.memorizeHint, { color: colors.mutedForeground }]}>
              {t("session.memorize.hint")}
            </Text>
          </View>
        )}

        {phase === "study" && stageIdx === 0 && (
          <View style={styles.section}>
            <ShadowSentenceFlow
              text={text.text}
              voice={settings.preferredVoice ?? "nova"}
              accentColor={stageColor}
              contentType={text.contentType}
              articleId={text.id}
              language={text.targetLanguage}
              onComplete={handleShadowFlowComplete}
            />
          </View>
        )}

        {phase === "study" && stageIdx === 1 && (
          <View style={styles.section}>
            <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
              <EyeOff size={28} color={colors.mutedForeground} />
              <Text style={[styles.hiddenTitle, { color: colors.foreground }]}>{t("session.dictation.hiddenTitle")}</Text>
              <Text style={[styles.hiddenSubtitle, { color: colors.mutedForeground }]}>
                {t("session.dictation.hiddenSub")}
              </Text>
            </View>

            <SentenceArticle
              text={text.text}
              accentColor={stageColor}
              visible={false}
              showPlayAll
              contentType={text.contentType}
              articleId={text.id}
              targetLanguage={text.targetLanguage}
              dictationMode
              playLimit={{
                remaining: dictationPlaysRemaining,
                total: DICTATION_MAX_PLAYS,
                onConsume: () =>
                  setDictationPlaysRemaining((n) => Math.max(0, n - 1)),
              }}
            />

            {(() => {
              const remaining = hintQuota.getRemaining();
              const remainingLabel = isPro
                ? t("dictation.hint.unlimited")
                : t("dictation.hint.remaining", { n: Math.max(0, remaining) });
              const mask = buildDictationHintMask(text.text, hintsUsedThisAttempt);
              const totalHintable = mask.totalHintable;
              const reachedReveals =
                totalHintable === 0 || hintsUsedThisAttempt >= totalHintable;
              // The button has three legal states (see handleUseHint):
              //   - "Hide" when the card is shown (always enabled).
              //   - "Hint" when more reveals are available.
              //   - "Hint" when at cap but the user has at least one
              //     reveal — tapping just re-shows the card without
              //     consumption.
              // It's only truly disabled when the sentence has no
              // hintable tokens (so there's nothing to ever show) OR
              // while the persisted quota state is still loading.
              const canShowExisting = hintsUsedThisAttempt > 0;
              const hintBtnDisabled =
                !hintQuota.isReady ||
                (totalHintable === 0 && !canShowExisting) ||
                (reachedReveals && !canShowExisting && !hintVisible);
              const hintBtnLabel = hintVisible
                ? t("dictation.hint.hideButton")
                : t("dictation.hint.button");
              return (
                <View style={[styles.hintBlock, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.hintHeaderRow}>
                    <TouchableOpacity
                      onPress={handleUseHint}
                      disabled={hintBtnDisabled}
                      activeOpacity={0.85}
                      style={[
                        styles.hintBtn,
                        {
                          backgroundColor: stageColor + "1F",
                          borderColor: stageColor + "55",
                          opacity: hintBtnDisabled ? 0.45 : 1,
                        },
                      ]}
                    >
                      <Lightbulb size={16} color={stageColor} />
                      <Text style={[styles.hintBtnText, { color: stageColor }]}>
                        {hintBtnLabel}
                      </Text>
                    </TouchableOpacity>
                    <Text style={[styles.hintRemaining, { color: colors.mutedForeground }]}>
                      {remainingLabel}
                    </Text>
                  </View>
                  {hintVisible && hintsUsedThisAttempt > 0 ? (
                    <>
                      <Text style={[styles.hintCardLabel, { color: colors.mutedForeground }]}>
                        {t("dictation.hint.cardLabel", {
                          used: hintsUsedThisAttempt,
                          total: Math.max(totalHintable, hintsUsedThisAttempt),
                        })}
                      </Text>
                      <Text
                        // RTL direction is determined from the original
                        // unmasked sentence — masked output is mostly
                        // ▁ characters, which would otherwise cause
                        // direction detection to fall back to LTR.
                        style={[styles.hintMaskText, { color: colors.foreground }, rtlTextStyle(text.text)]}
                        selectable={false}
                      >
                        {mask.display}
                      </Text>
                    </>
                  ) : (
                    <Text style={[styles.hintEmptyText, { color: colors.mutedForeground }]}>
                      {t("dictation.hint.empty")}
                    </Text>
                  )}
                  <Text style={[styles.hintScoreNote, { color: colors.mutedForeground }]}>
                    {t("dictation.hint.scoreNote", { n: HINT_SCORE_DEDUCTION_PER_USE })}
                  </Text>
                </View>
              );
            })()}

            <View style={[styles.dictationBox, { backgroundColor: colors.card, borderColor: stageColor }]}>
              <Text style={[styles.dictationLabel, { color: colors.mutedForeground }]}>{t("session.dictation.label")}</Text>
              <TextInput
                style={[styles.dictationInput, { color: colors.foreground }, rtlTextStyle(dictationInput)]}
                value={dictationInput}
                onChangeText={setDictationInput}
                placeholder={t("session.dictation.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                multiline
                textAlignVertical="top"
                autoCorrect={false}
              />
            </View>
            <TouchableOpacity
              onPress={handleDictationSubmit}
              disabled={!dictationInput.trim()}
              style={[styles.submitBtn, {
                backgroundColor: stageColor,
                opacity: dictationInput.trim() ? 1 : 0.4,
              }]}
              activeOpacity={0.85}
            >
              <Check size={20} color="#fff" />
              <Text style={styles.submitBtnText}>{t("session.dictation.submit")}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === "study" && stageIdx === 2 && (
          <View style={styles.section}>
            <View style={[styles.hiddenCard, { backgroundColor: colors.muted }]}>
              <BookOpen size={28} color={colors.mutedForeground} />
              <Text style={[styles.hiddenTitle, { color: colors.foreground }]}>{t("session.recite.title")}</Text>
              <Text style={[styles.hiddenSubtitle, { color: colors.mutedForeground }]}>
                {t("session.recite.sub")}
              </Text>
            </View>

            {(() => {
              // Hint controls live just above the record button so a
              // user who freezes mid-recitation can reveal a few more
              // keywords without leaving the recording screen.
              const hasKeywords = recitationHasKeywords;
              const allRevealed = recitationHintsAtCap;
              const hintBtnDisabled = !hasKeywords || allRevealed;
              const hintBtnLabel = isPro
                ? t("session.recite.hintProButton")
                : t("session.recite.hintButton");
              return (
                <View
                  style={[
                    styles.hintBlock,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <View style={styles.hintHeaderRow}>
                    <TouchableOpacity
                      onPress={handleRevealRecitationHint}
                      disabled={hintBtnDisabled}
                      activeOpacity={0.85}
                      style={[
                        styles.hintBtn,
                        {
                          backgroundColor: stageColor + "1F",
                          borderColor: stageColor + "55",
                          opacity: hintBtnDisabled ? 0.45 : 1,
                        },
                      ]}
                    >
                      <Lightbulb size={16} color={stageColor} />
                      <Text style={[styles.hintBtnText, { color: stageColor }]}>
                        {hintBtnLabel}
                      </Text>
                    </TouchableOpacity>
                    {recitationHintsRevealed > 0 ? (
                      <Text
                        style={[
                          styles.hintRemaining,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {allRevealed
                          ? t("session.recite.hintAllRevealed")
                          : t("session.recite.hintRevealedLabel", {
                              n: recitationHintPlan.revealedKeywords,
                              total: recitationHintPlan.totalKeywords,
                            })}
                      </Text>
                    ) : null}
                  </View>
                  {recitationHintsRevealed > 0 ? (
                    <Text
                      style={[
                        styles.hintMaskText,
                        { color: colors.foreground },
                        rtlTextStyle(text.text),
                      ]}
                      selectable={false}
                    >
                      {recitationHintPlan.display}
                    </Text>
                  ) : null}
                </View>
              );
            })()}

            <View style={styles.recordSection}>
              <TouchableOpacity
                onPress={handleRecord}
                style={[styles.recordBtn, {
                  backgroundColor: isRecording ? "#EF4444" : stageColor,
                  shadowColor: isRecording ? "#EF4444" : stageColor,
                }]}
                activeOpacity={0.85}
              >
                <Icon name={isRecording ? "square" : "mic"} size={32} color="#fff" />
              </TouchableOpacity>
              <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>
                {isRecording ? t("session.shadow.stopHint") : t("session.recite.startHint")}
              </Text>
              {isRecording && <AudioWaveform isActive color="#EF4444" />}
            </View>
          </View>
        )}

        {phase === "recording" && stageIdx !== 0 && (
          <View style={[styles.section, styles.centerSection]}>
            {/* Live transcript preview. Shows finalized text in normal
                style and the in-progress hypothesis dimmed/italic so
                users see exactly what the recognizer is hearing in
                real time. When availability is `false` (no platform
                support, denied permission, language unsupported, or
                a mid-session error) we surface a single subtle line
                so the user knows the live preview isn't available
                but recording is still going. The Whisper-based score
                still runs unchanged after stop. */}
            {liveTranscript.isLiveTranscriptAvailable === false ? (
              <Text
                style={[styles.liveTranscriptUnavailable, { color: colors.mutedForeground }]}
              >
                {t("session.recitation.liveUnavailable")}
              </Text>
            ) : liveTranscript.finalTranscript || liveTranscript.interimTranscript ? (
              <ScrollView
                style={[
                  styles.liveTranscriptBox,
                  { backgroundColor: colors.muted, borderColor: colors.border },
                ]}
                contentContainerStyle={styles.liveTranscriptContent}
                showsVerticalScrollIndicator={false}
                ref={(ref) => {
                  // Auto-scroll to bottom as new tokens arrive so the
                  // most recent words are always visible.
                  ref?.scrollToEnd?.({ animated: false });
                }}
              >
                <Text style={[styles.liveTranscriptText, { color: colors.foreground }]}>
                  {liveTranscript.finalTranscript}
                  {liveTranscript.finalTranscript && liveTranscript.interimTranscript ? " " : ""}
                  <Text style={[styles.liveTranscriptInterim, { color: colors.mutedForeground }]}>
                    {liveTranscript.interimTranscript}
                  </Text>
                </Text>
              </ScrollView>
            ) : liveTranscript.isLiveTranscriptAvailable === true ? (
              <Text
                style={[styles.liveTranscriptPlaceholder, { color: colors.mutedForeground }]}
              >
                {t("session.recitation.liveListening")}
              </Text>
            ) : null}
            <AudioWaveform isActive color="#EF4444" barCount={9} />
            <TouchableOpacity
              onPress={handleRecord}
              style={[styles.recordBtn, { backgroundColor: "#EF4444", shadowColor: "#EF4444" }]}
              activeOpacity={0.85}
            >
              <Square size={32} color="#fff" />
            </TouchableOpacity>
            <Text style={[styles.recordHint, { color: colors.mutedForeground }]}>{t("session.shadow.stopHint")}</Text>
          </View>
        )}

        {(phase === "transcribing" || phase === "scoring") && (
          <View style={[styles.section, styles.centerSection]}>
            <ActivityIndicator size="large" color={stageColor} />
            <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
              {phase === "transcribing" ? t("session.processing.transcribing") : t("session.processing.scoring")}
            </Text>
          </View>
        )}

        {phase === "result" && result && (
          <View style={styles.section}>
            {stage.needsScore ? (
              <>
                <View style={[
                  styles.passedBanner,
                  {
                    backgroundColor: result.passed ? "#10B981" + "15" : "#EF4444" + "15",
                    borderColor: result.passed ? "#10B981" : "#EF4444",
                  },
                ]}>
                  <Icon
                    name={result.passed ? "check-circle" : "x-circle"}
                    size={22}
                    color={result.passed ? "#10B981" : "#EF4444"}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.passedTitle, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                      {result.passed ? t("session.result.passed") : t("session.result.failed")}
                    </Text>
                    <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                      {result.passed
                        ? isLastStage ? t("session.result.allDone") : t("session.result.continueNext")
                        : t("session.result.needScore", { n: STAGE_PASS_SCORE })}
                    </Text>
                  </View>
                  <Text style={[styles.passedScore, { color: result.passed ? "#10B981" : "#EF4444" }]}>
                    {result.score}
                  </Text>
                </View>
                {(() => {
                  const targetTitle = t("session.annot.target");
                  const userTitle =
                    stageIdx === 1
                      ? t("session.annot.userWrote")
                      : t("session.annot.userSaid");
                  // Wrong + missed apply to all three scored modes; extra only
                  // when the user can supply tokens not in the target (stage 0
                  // shadowing transcript, stage 1 dictation typing).
                  const showExtra = stageIdx === 0 || stageIdx === 1;
                  const targetActive =
                    activeWord?.side === "target" ? activeWord.index : null;
                  const userActive =
                    activeWord?.side === "user" ? activeWord.index : null;
                  // Only surface the "tap to hear" hint when something is
                  // actually tappable (i.e. the model produced annotations
                  // with at least one wrong/missed token on either side).
                  const hasTappable =
                    (result.targetAnnotations?.some(
                      (a) => a.status === "wrong" || a.status === "missed"
                    ) ?? false) ||
                    (result.userAnnotations?.some(
                      (a) => a.status === "wrong" || a.status === "missed"
                    ) ?? false);
                  const targetNode = (
                    <AnnotatedText
                      title={targetTitle}
                      annotations={result.targetAnnotations}
                      fallbackText={text.text}
                      onWordPress={handleWordPress("target")}
                      activeIndex={targetActive}
                      activeColor={stage.color}
                    />
                  );
                  const userNode = (
                    <AnnotatedText
                      title={userTitle}
                      annotations={result.userAnnotations}
                      fallbackText={result.userTranscript}
                      onWordPress={handleWordPress("user")}
                      activeIndex={userActive}
                      activeColor={stage.color}
                    />
                  );
                  return (
                    <>
                      {stageIdx === 1 ? (
                        <>
                          {userNode}
                          {targetNode}
                        </>
                      ) : (
                        <>
                          {targetNode}
                          {userNode}
                        </>
                      )}
                      {hasTappable ? (
                        <Text
                          style={[
                            styles.tapHint,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {t("session.annot.tapHint")}
                        </Text>
                      ) : null}
                      <AnnotatedLegend
                        show={{
                          wrong: true,
                          missed: true,
                          extra: showExtra,
                          // Only the shadowing stage produces "unsure"
                          // tokens (it's the only flow with the
                          // multi-signal scorer behind it). Hide the
                          // legend entry elsewhere to avoid implying
                          // the status exists in dictation/recitation.
                          unsure: stageIdx === 0,
                        }}
                        labels={{
                          wrong: t("session.annot.legend.wrong"),
                          missed: t("session.annot.legend.missed"),
                          extra: t("session.annot.legend.extra"),
                          unsure: t("session.annot.legend.unsure"),
                        }}
                      />
                    </>
                  );
                })()}
                <ScoreCard
                  score={result.score}
                  feedback={result.feedback}
                  details={result.details}
                  mode={stage.mode as LearningMode}
                  perSentence={result.perSentence}
                  onSentencePress={handleSentencePress}
                  playingIndex={activeSentenceIndex}
                  analysisLocked={analysisLocked}
                  onUnlockAnalysis={handleAnalysisUnlock}
                  isUnlocking={analysisUnlocking}
                  tips={buildScoreTips({
                    mode: stage.mode as LearningMode,
                    metrics: result.metrics ?? {},
                  })}
                />
                {/* Recitation (stage 2) and the new shadow flow (stage 0)
                    both produce a single full-passage recording the user
                    can replay against the highlighted target text. Stage 1
                    (dictation) has no audio so the button is suppressed
                    there. */}
                {(stageIdx === 0 || stageIdx === 2) && activeRecordingUri ? (
                  <TouchableOpacity
                    onPress={handlePlayMyRecording}
                    style={[
                      styles.playMyRecordingBtn,
                      { borderColor: colors.border, backgroundColor: colors.muted },
                    ]}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={t("session.shadow.playMyRecording")}
                  >
                    {isPlayingRecording ? (
                      <Square size={16} color={colors.foreground} />
                    ) : (
                      <Volume2 size={16} color={colors.foreground} />
                    )}
                    <Text
                      style={[
                        styles.playMyRecordingBtnText,
                        { color: colors.foreground },
                      ]}
                    >
                      {t("session.shadow.playMyRecording")}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : (
              <View style={[styles.passedBanner, { backgroundColor: "#10B981" + "15", borderColor: "#10B981" }]}>
                <Headphones size={22} color="#10B981" />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.passedTitle, { color: "#10B981" }]}>{t("session.result.listeningDone")}</Text>
                  <Text style={[styles.passedSub, { color: colors.mutedForeground }]}>
                    {t("session.result.unlockNext")}
                  </Text>
                </View>
              </View>
            )}

            {stageIdx < STAGES.length - 1 && (
              <View style={[styles.nextStageHint, { backgroundColor: colors.muted }]}>
                <Icon name={STAGES[stageIdx + 1].icon as any} size={16} color={STAGES[stageIdx + 1].color} />
                <Text style={[styles.nextStageText, { color: colors.foreground }]}>
                  {t("session.result.nextStageHint", { name: getStageName(stageIdx + 1, lang) })}
                </Text>
              </View>
            )}

            {!stage.needsScore && (
              <View style={[styles.originalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.originalLabel, { color: colors.mutedForeground }]}>{t("session.result.original")}</Text>
                <Text style={[styles.originalText, { color: colors.foreground }, rtlTextStyle(text.text)]}>{text.text}</Text>
              </View>
            )}

            <View style={styles.resultActions}>
              <TouchableOpacity
                onPress={handleRetry}
                style={[styles.retryBtn, { borderColor: colors.border }]}
                activeOpacity={0.85}
              >
                <RefreshCw size={16} color={colors.mutedForeground} />
                <Text style={[styles.retryBtnText, { color: colors.mutedForeground }]}>{t("session.result.retry")}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleNextStage}
                style={[styles.doneBtn, { backgroundColor: stageColor }]}
                activeOpacity={0.85}
              >
                <Text style={styles.doneBtnText}>
                  {result.passed && !isLastStage ? t("session.result.next") : t("session.result.return")}
                </Text>
                <Icon name={result.passed && !isLastStage ? "arrow-right" : "check"} size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
      </KeyboardAvoidingView>
      </Animated.View>

      {hasGeom && overlayMounted && initialGeom && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.overlay,
            {
              backgroundColor: colors.card,
              borderColor: overlayBorderColor,
            },
            overlayBgStyle,
          ]}
        >
          <Animated.View
            style={[
              styles.overlaySnapshot,
              {
                width: initialGeom.width,
                height: initialGeom.height,
              },
              contentSnapStyle,
            ]}
          >
            <StageCard
              idx={stageIdx}
              locked={snapshotLocked}
              passed={snapshotPassed}
              current={snapshotCurrent}
              best={progressForText?.stageBests?.[stageIdx] ?? 0}
              lang={lang}
              snapshot
            />
          </Animated.View>
        </Animated.View>
      )}

      {micPermissionModal}

      <Modal
        visible={hintAdPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => !hintAdInFlight && setHintAdPrompt(false)}
      >
        <View style={styles.adPromptBackdrop}>
          <View
            style={[
              styles.adPromptCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View
              style={[
                styles.adPromptIcon,
                { backgroundColor: stageColor + "1F" },
              ]}
            >
              <Lightbulb size={24} color={stageColor} />
            </View>
            <Text style={[styles.adPromptTitle, { color: colors.foreground }]}>
              {t("dictation.hint.outTitle")}
            </Text>
            <Text
              style={[styles.adPromptBody, { color: colors.mutedForeground }]}
            >
              {t("dictation.hint.outBody", { total: HINT_FREE_PER_DAY })}
            </Text>
            <TouchableOpacity
              onPress={handleHintWatchAd}
              disabled={hintAdInFlight}
              activeOpacity={0.85}
              style={[
                styles.adPromptPrimary,
                {
                  backgroundColor: stageColor,
                  opacity: hintAdInFlight ? 0.6 : 1,
                },
              ]}
            >
              {hintAdInFlight ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Sparkles size={16} color="#fff" />
              )}
              <Text style={styles.adPromptPrimaryText}>
                {t("dictation.hint.exhausted")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setHintAdPrompt(false)}
              disabled={hintAdInFlight}
              activeOpacity={0.85}
              style={styles.adPromptSecondary}
            >
              <Text
                style={[
                  styles.adPromptSecondaryText,
                  { color: colors.mutedForeground },
                ]}
              >
                {t("ads.dismiss")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={recitationHintAdPrompt}
        transparent
        animationType="fade"
        onRequestClose={() =>
          !recitationHintAdInFlight && setRecitationHintAdPrompt(false)
        }
      >
        <View style={styles.adPromptBackdrop}>
          <View
            style={[
              styles.adPromptCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View
              style={[
                styles.adPromptIcon,
                { backgroundColor: stageColor + "1F" },
              ]}
            >
              <Lightbulb size={24} color={stageColor} />
            </View>
            <Text style={[styles.adPromptTitle, { color: colors.foreground }]}>
              {t("session.recite.hintAdTitle")}
            </Text>
            <Text
              style={[styles.adPromptBody, { color: colors.mutedForeground }]}
            >
              {t("session.recite.hintAdBody")}
            </Text>
            <TouchableOpacity
              onPress={handleRecitationHintWatchAd}
              disabled={recitationHintAdInFlight}
              activeOpacity={0.85}
              style={[
                styles.adPromptPrimary,
                {
                  backgroundColor: stageColor,
                  opacity: recitationHintAdInFlight ? 0.6 : 1,
                },
              ]}
            >
              {recitationHintAdInFlight ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Sparkles size={16} color="#fff" />
              )}
              <Text style={styles.adPromptPrimaryText}>
                {t("session.recite.hintAdCta")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setRecitationHintAdPrompt(false)}
              disabled={recitationHintAdInFlight}
              activeOpacity={0.85}
              style={styles.adPromptSecondary}
            >
              <Text
                style={[
                  styles.adPromptSecondaryText,
                  { color: colors.mutedForeground },
                ]}
              >
                {t("ads.dismiss")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  contentWrap: { flex: 1 },
  overlay: {
    position: "absolute",
    overflow: "hidden",
    borderStyle: "solid",
  },
  overlaySnapshot: {
    position: "absolute",
    top: 0,
    left: 0,
  },
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
  headerStage: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  progressBar: {
    height: 3,
    marginHorizontal: 0,
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 14,
  },
  section: { gap: 14 },
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
    gap: 10,
  },
  introBadge: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  introLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  introTitle: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  introDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
    textAlign: "center",
  },
  thresholdTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  thresholdText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 6,
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
  completeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
  },
  completeBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  countdownCard: {
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 4,
  },
  countdownNum: {
    fontSize: 56,
    fontFamily: "Inter_700Bold",
  },
  countdownLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  memorizeHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  hiddenCard: {
    borderRadius: 16,
    padding: 28,
    alignItems: "center",
    gap: 8,
  },
  hiddenTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  hiddenSubtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
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
  liveTranscriptBox: {
    width: "100%",
    maxHeight: 140,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  liveTranscriptContent: {
    flexGrow: 1,
  },
  liveTranscriptText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    lineHeight: 22,
  },
  liveTranscriptInterim: {
    fontStyle: "italic",
    fontFamily: "Inter_400Regular",
  },
  liveTranscriptPlaceholder: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  liveTranscriptUnavailable: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  hintBlock: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  hintHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  hintBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  hintBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  hintRemaining: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
    textAlign: "right",
  },
  hintCardLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 2,
  },
  hintMaskText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    lineHeight: 26,
    letterSpacing: 1,
  },
  hintEmptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
  hintScoreNote: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
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
  passedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  passedTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  passedSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  passedScore: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
  },
  nextStageHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 10,
  },
  nextStageText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  tapHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    paddingHorizontal: 4,
    marginTop: -4,
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
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 24,
  },
  resultActions: {
    flexDirection: "row",
    gap: 10,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
  },
  retryBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  doneBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    flex: 2,
  },
  doneBtnText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  playMyRecordingBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "center",
  },
  playMyRecordingBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  adPromptBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  adPromptCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 18,
    borderWidth: 1,
    padding: 22,
    alignItems: "center",
    gap: 10,
  },
  adPromptIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  adPromptTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  adPromptBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 6,
  },
  adPromptPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    paddingVertical: 13,
    borderRadius: 12,
  },
  adPromptPrimaryText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  adPromptSecondary: {
    paddingVertical: 8,
  },
  adPromptSecondaryText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
