import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  BackHandler,
  useWindowDimensions,
} from "react-native";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Book, Check, ChevronRight, Lock, Star } from "lucide-react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { SentenceArticle } from "@/components/SentenceArticle";
import { TextCard } from "@/components/TextCard";
import { VocabularyList } from "@/components/VocabularyList";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import { useT, getStageName, getStageDesc } from "@/utils/i18n";
import { Icon, type IconName } from "@/components/Icon";

// Open uses a strong ease-out ("Expo Out") to mimic the iOS App Store launch
// feel: a sharp, fast initial burst followed by a long, soft settle. The
// duration is intentionally a bit longer than the close so the deceleration
// tail has room to be felt without making the open feel sluggish.
const OPEN_DURATION = 650;
const CLOSE_DURATION = 280;
const OPEN_EASING = Easing.bezier(0.16, 1, 0.3, 1);
const CLOSE_EASING = Easing.bezier(0.4, 0, 0.2, 1);

export default function PracticeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const params = useLocalSearchParams<{
    id: string;
    oX?: string;
    oY?: string;
    oW?: string;
    oH?: string;
    oR?: string;
  }>();
  const { id } = params;
  const { texts, getProgressForText, settings, addText } = useApp();
  const navigation = useNavigation();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const text = texts.find((x) => x.id === id);
  const lang = settings.nativeLanguage;
  const progress = text ? getProgressForText(text.id) : undefined;

  const [showVocab, setShowVocab] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 50 : insets.bottom + 20;

  // ---- Card-expand transition (overlay) ----
  const initialGeom = useRef(parseGeom(params, screenW, screenH)).current;
  const hasGeom = initialGeom != null && Platform.OS !== "web";

  // Match the originating card chrome so the start of the animation lines up
  // with what the user just tapped (mastered cards get a green tint + 1.5px
  // border; everything else uses the standard border at hairline width).
  const overlayStagePassed = progress?.stagePassed ?? STAGES.map(() => false);
  const overlayAllDone = STAGES.every((_, i) => overlayStagePassed[i]);
  const overlayBorderColor = overlayAllDone ? "#10B981" + "60" : colors.border;
  const overlayMaxBorder = overlayAllDone ? 1.5 : StyleSheet.hairlineWidth;

  // progress: 0 = card geometry, 1 = fullscreen. The snapshot opacity and the
  // underlying screen opacity are both derived from this so they crossfade
  // exactly in sync (no blank/white-box moment in the middle of the animation).
  const progressSV = useSharedValue(hasGeom ? 0 : 1);
  // overlayVisible toggles the overlay node (kept mounted while animating, hidden after)
  const [overlayMounted, setOverlayMounted] = useState(hasGeom);
  const closingRef = useRef(false);

  useEffect(() => {
    if (!hasGeom) return;
    // Run open animation on next frame so the initial state is committed first.
    const handle = requestAnimationFrame(() => {
      progressSV.value = withTiming(1, { duration: OPEN_DURATION, easing: OPEN_EASING }, (finished) => {
        if (finished) runOnJS(setOverlayMounted)(false);
      });
    });
    return () => cancelAnimationFrame(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reverse animation -> then dispatch the original navigation action.
  const runCloseAnimation = useCallback(
    (onDone: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;
      setOverlayMounted(true);
      progressSV.value = withTiming(0, { duration: CLOSE_DURATION, easing: CLOSE_EASING }, (finished) => {
        if (finished) runOnJS(onDone)();
      });
    },
    [progressSV],
  );

  // Intercept navigation back to play the reverse animation first.
  useEffect(() => {
    if (!hasGeom) return;
    // The event handler is typed via inference from `navigation.addListener`.
    const sub = navigation.addListener("beforeRemove", (e) => {
      if (closingRef.current) return; // already animating, allow it.
      e.preventDefault();
      runCloseAnimation(() => {
        navigation.dispatch(e.data.action);
      });
    });
    return sub;
  }, [navigation, runCloseAnimation, hasGeom]);

  // Hardware back on Android: let it propagate; beforeRemove will catch it.
  // But on Android, `BackHandler` fires before navigation listeners only if we
  // return false. We return false to let the default handler call back().
  useEffect(() => {
    if (Platform.OS !== "android" || !hasGeom) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => false);
    return () => sub.remove();
  }, [hasGeom]);

  const overlayStyle = useAnimatedStyle(() => {
    if (!initialGeom) {
      return { opacity: 0 };
    }
    const p = progressSV.value;
    const inv = 1 - p;
    // The overlay panel AND its snapshot child fade together. Crucially this
    // means at p=1 the overlay is fully transparent, so when we mount it on
    // close (which happens at p=1) the user keeps seeing the practice screen
    // underneath rather than a blank fullscreen panel for a frame.
    // Window shifted earlier (0.45 → 0.9) because the new ease-out covers
    // most of the geometry change in the first ~30% of time; we want the
    // snapshot to start handing off to real content well before fullscreen.
    const overlayOp = p <= 0.45 ? 1 : p >= 0.9 ? 0 : 1 - (p - 0.45) / 0.45;
    return {
      top: initialGeom.y * inv,
      left: initialGeom.x * inv,
      width: initialGeom.width + (screenW - initialGeom.width) * p,
      height: initialGeom.height + (screenH - initialGeom.height) * p,
      borderRadius: initialGeom.radius * inv,
      // Match the originating card border, fade thickness to 0 by the time
      // the overlay reaches fullscreen so no stray edge or radius gap shows.
      borderWidth: overlayMaxBorder * inv,
      opacity: overlayOp,
    };
  }, [
    initialGeom?.x,
    initialGeom?.y,
    initialGeom?.width,
    initialGeom?.height,
    screenW,
    screenH,
    overlayMaxBorder,
  ]);

  // Underlying screen content fades in (open) / out (close) symmetrically, in
  // a window that fully overlaps the snapshot's fade so neither layer is
  // invisible while the other is also invisible. Window shifted earlier to
  // match the ease-out front-loading, so the practice screen is essentially
  // fully visible by the time the geometry finishes settling.
  const contentStyle = useAnimatedStyle(() => {
    const p = progressSV.value;
    const op = p <= 0.4 ? 0 : p >= 0.9 ? 1 : (p - 0.4) / 0.5;
    return { opacity: op };
  });

  const handleBack = useCallback(() => {
    router.back();
  }, []);

  if (!text) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.foreground, padding: 20 }}>{t("home.notFound")}</Text>
      </View>
    );
  }

  const stagePassed = progress?.stagePassed ?? STAGES.map(() => false);
  const stageBests = progress?.stageBests ?? STAGES.map(() => 0);

  const isUnlocked = (idx: number) => idx === 0 || stagePassed[idx - 1];
  const isPassed = (idx: number) => stagePassed[idx];
  const isCurrent = (idx: number) => isUnlocked(idx) && !isPassed(idx);

  const allPassed = STAGES.every((_, i) => stagePassed[i]);
  const totalScore = stageBests.filter((s) => s > 0).length > 0
    ? Math.round(stageBests.reduce((a, b) => a + b, 0) / STAGES.length)
    : 0;

  const handleStartStage = (stageIdx: number) => {
    if (!isUnlocked(stageIdx)) return;
    router.push({ pathname: "/session", params: { id: text.id, stage: stageIdx.toString() } });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Animated.View style={[styles.contentWrap, hasGeom ? contentStyle : null]}>
        <View style={[styles.header, { paddingTop: topPad + 12 }]}>
          <TouchableOpacity onPress={handleBack} style={styles.backBtn} activeOpacity={0.7}>
            <ArrowLeft size={22} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
            {text.title}
          </Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
          showsVerticalScrollIndicator={false}
        >
          <SentenceArticle
            text={text.text}
            voice={settings.preferredVoice}
            accentColor={colors.primary}
            contentType={text.contentType}
            articleId={text.id}
          />

          <View style={styles.textActions}>
            {text.translation ? (
              <TouchableOpacity
                onPress={() => setShowTranslation(!showTranslation)}
                style={[styles.pillBtn, { borderColor: colors.border }]}
                activeOpacity={0.7}
              >
                <Icon name={showTranslation ? "eye-off" : "eye"} size={13} color={colors.mutedForeground} />
                <Text style={[styles.pillBtnText, { color: colors.mutedForeground }]}>
                  {showTranslation ? t("practice.translation.hide") : t("practice.translation.show")}
                </Text>
              </TouchableOpacity>
            ) : null}
            {text.vocabulary?.length > 0 ? (
              <TouchableOpacity
                onPress={() => setShowVocab(!showVocab)}
                style={[styles.pillBtn, { borderColor: colors.border }]}
                activeOpacity={0.7}
              >
                <Book size={13} color={colors.mutedForeground} />
                <Text style={[styles.pillBtnText, { color: colors.mutedForeground }]}>
                  {t("practice.vocab", { n: text.vocabulary.length })}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {showTranslation && text.translation ? (
            <View style={[styles.translationCard, { backgroundColor: colors.muted }]}>
              <Text style={[styles.translationLabel, { color: colors.mutedForeground }]}>{t("practice.translationLabel")}</Text>
              <Text style={[styles.translation, { color: colors.foreground }]}>
                {text.translation}
              </Text>
            </View>
          ) : null}

          {showVocab && text.vocabulary.length > 0 && (
            <VocabularyList
              text={text}
              onUpdateVocabulary={(vocab) => addText({ ...text, vocabulary: vocab })}
            />
          )}

          {allPassed && (
            <View style={[styles.masteredBanner, { backgroundColor: "#10B981" + "20", borderColor: "#10B981" }]}>
              <Star size={20} color="#10B981" />
              <View style={{ flex: 1 }}>
                <Text style={[styles.masteredTitle, { color: "#10B981" }]}>{t("practice.mastered.title")}</Text>
                <Text style={[styles.masteredSub, { color: "#10B981" + "CC" }]}>{t("practice.mastered.sub", { score: totalScore })}</Text>
              </View>
            </View>
          )}

          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{t("practice.section.stages")}</Text>

          <View style={styles.stagesContainer}>
            {STAGES.map((stage, idx) => {
              const locked = !isUnlocked(idx);
              const passed = isPassed(idx);
              const current = isCurrent(idx);
              const best = stageBests[idx];

              return (
                <View key={idx} style={styles.stageRow}>
                  {idx < STAGES.length - 1 && (
                    <View
                      style={[
                        styles.stageLine,
                        { backgroundColor: passed ? stage.color : colors.border },
                      ]}
                    />
                  )}

                  <TouchableOpacity
                    onPress={() => handleStartStage(idx)}
                    disabled={locked}
                    activeOpacity={locked ? 1 : 0.85}
                    style={[
                      styles.stageCard,
                      {
                        backgroundColor: colors.card,
                        borderColor: current
                          ? stage.color
                          : passed
                          ? stage.color + "60"
                          : colors.border,
                        borderWidth: current ? 2 : 1,
                        opacity: locked ? 0.45 : 1,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.stageBadge,
                        {
                          backgroundColor: passed
                            ? stage.color
                            : current
                            ? stage.color + "20"
                            : colors.muted,
                        },
                      ]}
                    >
                      {passed ? (
                        <Check size={20} color="#fff" />
                      ) : locked ? (
                        <Lock size={18} color={colors.mutedForeground} />
                      ) : (
                        <Icon name={stage.icon as any} size={20} color={stage.color} />
                      )}
                    </View>

                    <View style={styles.stageInfo}>
                      <View style={styles.stageHeader}>
                        <Text style={[styles.stageNum, { color: colors.mutedForeground }]}>
                          {t("practice.stageNum", { n: idx + 1 })}
                        </Text>
                        {current && (
                          <View style={[styles.currentTag, { backgroundColor: stage.color }]}>
                            <Text style={styles.currentTagText}>{t("practice.current")}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.stageName, { color: locked ? colors.mutedForeground : colors.foreground }]}>
                        {getStageName(idx, lang)}
                      </Text>
                      <Text style={[styles.stageDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                        {getStageDesc(idx, lang)}
                      </Text>
                      {stage.needsScore && (
                        <Text style={[styles.stageThreshold, { color: colors.mutedForeground }]}>
                          {t("practice.passReq", { n: STAGE_PASS_SCORE })}
                        </Text>
                      )}
                    </View>

                    <View style={styles.stageRight}>
                      {best > 0 ? (
                        <View style={styles.scoreBlock}>
                          <Text style={[styles.scoreBig, { color: passed ? stage.color : colors.mutedForeground }]}>
                            {best}
                          </Text>
                          <Text style={[styles.scoreLabel, { color: colors.mutedForeground }]}>{t("practice.bestLabel")}</Text>
                        </View>
                      ) : locked ? null : (
                        <ChevronRight size={20} color={stage.color} />
                      )}
                    </View>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </Animated.View>

      {hasGeom && overlayMounted && initialGeom ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.overlay,
            {
              backgroundColor: colors.card,
              borderColor: overlayBorderColor,
              overflow: "hidden",
            },
            overlayStyle,
          ]}
        >
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: initialGeom.width,
              height: initialGeom.height,
            }}
          >
            <TextCard
              snapshot
              item={text}
              onPress={() => {}}
              stagesPassed={stagePassed}
            />
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

type Geom = { x: number; y: number; width: number; height: number; radius: number };

function parseGeom(
  params: { oX?: string; oY?: string; oW?: string; oH?: string; oR?: string },
  screenW: number,
  screenH: number,
): Geom | null {
  const x = params.oX != null ? Number(params.oX) : NaN;
  const y = params.oY != null ? Number(params.oY) : NaN;
  const width = params.oW != null ? Number(params.oW) : NaN;
  const height = params.oH != null ? Number(params.oH) : NaN;
  const radius = params.oR != null ? Number(params.oR) : 16;
  if ([x, y, width, height].some((v) => !Number.isFinite(v))) return null;
  if (width <= 0 || height <= 0) return null;
  // Sanity: ignore obviously off-screen geometries (e.g. scrolled out of view).
  if (y + height < 0 || y > screenH || x + width < 0 || x > screenW) return null;
  return { x, y, width, height, radius: Number.isFinite(radius) ? radius : 16 };
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  contentWrap: { flex: 1 },
  overlay: {
    position: "absolute",
  },
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
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    flex: 1,
    textAlign: "center",
    marginHorizontal: 8,
  },
  content: {
    paddingHorizontal: 20,
    gap: 14,
  },
  textActions: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  pillBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillBtnText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  translationCard: {
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  translationLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  translation: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 22,
  },
  vocabCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  vocabRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    gap: 8,
  },
  vocabLeft: { flex: 1 },
  vocabWord: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  vocabPron: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  vocabMeaning: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
    textAlign: "right",
  },
  masteredBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  masteredTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  masteredSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: -4,
  },
  stagesContainer: {
    gap: 0,
    paddingBottom: 8,
  },
  stageRow: {
    position: "relative",
  },
  stageLine: {
    position: "absolute",
    left: 28,
    bottom: 0,
    width: 2,
    height: 18,
    zIndex: 0,
  },
  stageCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 18,
    padding: 16,
    gap: 14,
    marginBottom: 10,
    zIndex: 1,
  },
  stageBadge: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stageInfo: {
    flex: 1,
    gap: 2,
  },
  stageHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stageNum: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  currentTag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  currentTagText: {
    color: "#fff",
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
  },
  stageName: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
  },
  stageDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
  },
  stageThreshold: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  stageRight: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 40,
  },
  scoreBlock: {
    alignItems: "center",
  },
  scoreBig: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },
  scoreLabel: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
  },
});
