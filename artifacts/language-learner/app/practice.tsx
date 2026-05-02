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
import { flipIfRTL } from "@/utils/rtl";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { SentenceArticle } from "@/components/SentenceArticle";
import { TextCard } from "@/components/TextCard";
import { VocabularyList } from "@/components/VocabularyList";
import { STAGES, STAGE_PASS_SCORE } from "@/types";
import { useT, getStageName, getStageDesc } from "@/utils/i18n";
import { Icon } from "@/components/Icon";

// Open uses a strong ease-out ("Expo Out") to mimic the iOS App Store launch
// feel: a sharp, fast initial burst followed by a long, soft settle. Close is
// shorter so back gestures feel snappy.
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
  const r = Number(p.oR ?? "16");
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return null;
  }
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h, radius: Number.isFinite(r) ? r : 16 };
}

const noop = () => {};

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

  // ---- Card-expand transition ----
  // Geometry params are captured from `measureInWindow` on the home page and
  // passed through the router; we snapshot once on mount so a layout change
  // mid-animation can't tear the interpolation.
  const initialGeom = useRef(parseGeom(params)).current;
  const hasGeom = initialGeom != null && Platform.OS !== "web";

  const stagePassed = progress?.stagePassed ?? STAGES.map(() => false);
  const stageBests = progress?.stageBests ?? STAGES.map(() => 0);
  const allPassed = STAGES.every((_, i) => stagePassed[i]);

  // Match the originating card chrome so the start of the animation lines up
  // with what the user just tapped (mastered cards get a green tint + 1.5px
  // border; everything else uses the standard border at hairline width).
  const overlayBorderColor = allPassed ? "#10B981" + "60" : colors.border;
  const overlayMaxBorder = allPassed ? 1.5 : StyleSheet.hairlineWidth;

  // progress: 0 = card geometry, 1 = fullscreen. The snapshot opacity, the
  // overlay panel opacity, and the underlying screen opacity are all derived
  // from this so they crossfade exactly in sync — no blank/white-box moment
  // and no stretched-text moment in the middle of the animation.
  const progressSV = useSharedValue(hasGeom ? 0 : 1);
  // The overlay mounts once when this screen opens with a geometry param and
  // then stays mounted for the lifetime of the screen. We deliberately do NOT
  // unmount it when the open animation completes: on Android, tearing down
  // the overlay's view tree in the same React commit as the animation
  // finishing produces a one-frame flash even though the overlay is already
  // at opacity 0. Leaving it mounted with `pointerEvents="none"` and
  // `bgOp === 0` at p=1 is invisible and free, and avoids that flash. It
  // also means the close animation can re-use the same view (no remount
  // before the reverse interpolation starts).
  const [overlayMounted] = useState(hasGeom);
  const closingRef = useRef(false);

  useEffect(() => {
    if (!hasGeom) return;
    // Run the open animation on the next frame so the initial state is
    // committed first; otherwise the overlay can flash at p=1 for one frame.
    const handle = requestAnimationFrame(() => {
      progressSV.value = withTiming(
        1,
        { duration: OPEN_DURATION, easing: OPEN_EASING },
        // No completion callback — we intentionally leave the overlay
        // mounted (see `overlayMounted` comment above).
      );
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

  // Intercept navigation back so the reverse animation runs first.
  useEffect(() => {
    if (!hasGeom) return;
    const sub = navigation.addListener("beforeRemove", (e) => {
      if (closingRef.current) return; // already animating, allow it.
      e.preventDefault();
      runCloseAnimation(() => {
        // Wait one extra frame before handing control to the navigator.
        // The reanimated completion callback fires on the JS thread in the
        // same tick as this dispatch, so without the rAF Android composites
        // the (already-cleared) practice content with the still-visible
        // overlay during the navigation tear-down, producing a flash on
        // the home screen's first frame. Deferring lets the final clean
        // overlay-only frame paint first; the home screen then takes over.
        requestAnimationFrame(() => {
          navigation.dispatch(e.data.action);
        });
      });
    });
    return sub;
  }, [navigation, runCloseAnimation, hasGeom]);

  // Hardware back on Android: let it propagate to the navigator so
  // `beforeRemove` above can wrap it in the reverse animation.
  useEffect(() => {
    if (Platform.OS !== "android" || !hasGeom) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => false);
    return () => sub.remove();
  }, [hasGeom]);

  // Background layer: a card-colored panel that interpolates from the
  // originating card's geometry to the full screen. Border + radius shrink
  // to 0 by the time it fills the screen so no stray edge or corner remains
  // when the practice screen takes over.
  const overlayBgStyle = useAnimatedStyle(() => {
    if (!initialGeom) {
      return { opacity: 0 };
    }
    const p = progressSV.value;
    const inv = 1 - p;
    // Background fades out only at the very end so we always have a solid
    // surface behind the snapshot; by then the practice content is fully
    // crossfaded in underneath.
    const bgOp = p <= 0.85 ? 1 : Math.max(0, 1 - (p - 0.85) / 0.15);
    return {
      top: initialGeom.y * inv,
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
  ]);

  // Snapshot layer: rendered as a child of the background layer so it
  // travels with it. Its container is pinned to (0, 0) at the original card
  // width/height — the layout never reflows, so text doesn't horizontally
  // stretch as the background grows. A modest uniform `scale` lets the
  // snapshot grow visually along with the background, so the user perceives
  // "this card is opening up" rather than "a colored block is spreading".
  // The snapshot fades out before the background reaches fullscreen so we
  // never see large card-content sitting on a fullscreen colored block.
  const contentScaleTarget = initialGeom
    ? Math.min(1.6, Math.max(1, screenW / initialGeom.width))
    : 1;
  const contentSnapStyle = useAnimatedStyle(() => {
    if (!initialGeom) return { opacity: 0 };
    const p = progressSV.value;
    const s = 1 + (contentScaleTarget - 1) * p;
    const op = p <= 0.55 ? 1 : p >= 0.9 ? 0 : 1 - (p - 0.55) / 0.35;
    return {
      transform: [{ scale: s }],
      opacity: op,
    };
  }, [contentScaleTarget, initialGeom?.width, initialGeom?.height]);

  // Practice screen body crossfades in (open) / out (close) inside the
  // window where the snapshot is fading out, so the user always sees one
  // layer or the other and never a blank screen.
  //
  // The fade-in completes at p=0.85, exactly where the overlay's background
  // begins to fade out. That ordering is important on Android: if the
  // content is still <1.0 while the overlay is already <1.0 (the previous
  // 0.85–0.9 window), the two semi-transparent layers composite into a
  // visibly muddy frame just before the overlay disappears.
  const contentStyle = useAnimatedStyle(() => {
    const p = progressSV.value;
    const op = p <= 0.4 ? 0 : p >= 0.85 ? 1 : (p - 0.4) / 0.45;
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

  const isUnlocked = (idx: number) => idx === 0 || stagePassed[idx - 1];
  const isPassed = (idx: number) => stagePassed[idx];
  const isCurrent = (idx: number) => isUnlocked(idx) && !isPassed(idx);

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
            <ArrowLeft size={22} color={colors.foreground} style={flipIfRTL()} />
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
            accentColor={colors.primary}
            contentType={text.contentType}
            articleId={text.id}
            targetLanguage={text.targetLanguage}
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

          {showVocab && (text.vocabulary?.length ?? 0) > 0 && (
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
                        <ChevronRight size={20} color={stage.color} style={flipIfRTL()} />
                      )}
                    </View>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </Animated.View>

      {hasGeom && overlayMounted && initialGeom && (
        <Animated.View
          pointerEvents="none"
          // Composite the panel + the snapshot inside as a single offscreen
          // texture before blending over the practice content. Without this,
          // Android alpha-blends each child View independently against the
          // underlying content, which produces visible seams during the
          // open/close crossfade and a flash on the very last frame.
          renderToHardwareTextureAndroid
          needsOffscreenAlphaCompositing
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
            <TextCard
              item={text}
              snapshot
              stagesPassed={stagePassed}
              onPress={noop}
            />
          </Animated.View>
        </Animated.View>
      )}
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
