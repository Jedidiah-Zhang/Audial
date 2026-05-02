import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import { Sparkles, Volume2, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import {
  _registerRewardedAdSimulator,
  type AdPlacement,
  type AdShowOutcome,
} from "@/hooks/useRewardedAd";

const COUNTDOWN_SECONDS = 5;

interface ActiveRequest {
  placement: AdPlacement;
  resolve: (outcome: AdShowOutcome) => void;
}

/**
 * Renders a fake "rewarded video" modal that plays for a few seconds
 * before granting the reward. Mounted once at the app root so any
 * screen calling `useRewardedAd().show()` triggers the same UI.
 *
 * In production this entire component is replaced by the AdMob SDK's
 * own full-screen ad presentation; see `useRewardedAd.ts` for the swap
 * path.
 */
export function RewardedAdSimulatorHost() {
  const colors = useColors();
  const t = useT();
  const [request, setRequest] = useState<ActiveRequest | null>(null);
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const requestRef = useRef<ActiveRequest | null>(null);
  requestRef.current = request;

  useEffect(() => {
    return _registerRewardedAdSimulator((req) => {
      // If a previous request is somehow still pending, dismiss it
      // first so we don't leak a never-resolved promise.
      const prev = requestRef.current;
      if (prev) prev.resolve("dismissed");
      setRequest(req);
      setRemaining(COUNTDOWN_SECONDS);
    });
  }, []);

  useEffect(() => {
    if (!request) return;
    if (remaining <= 0) {
      // Auto-grant the reward when the countdown hits zero.
      request.resolve("rewarded");
      setRequest(null);
      return;
    }
    const id = setTimeout(() => setRemaining((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [request, remaining]);

  const handleSkip = () => {
    if (!request) return;
    request.resolve("dismissed");
    setRequest(null);
  };

  if (!request) return null;

  const placementLabel = (() => {
    switch (request.placement) {
      case "generation":
        return t("ads.placement.generation");
      case "analysis_unlock":
        return t("ads.placement.analysis");
      case "dictation_replay":
        return t("ads.placement.dictation");
      default:
        return "";
    }
  })();

  return (
    <Modal
      visible
      animationType="fade"
      transparent
      onRequestClose={handleSkip}
      statusBarTranslucent={Platform.OS === "android"}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.iconWrap, { backgroundColor: colors.primary + "1A" }]}>
            <Volume2 size={32} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {t("ads.simulator.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {placementLabel}
          </Text>
          <View style={[styles.counter, { borderColor: colors.primary }]}>
            <Text style={[styles.counterText, { color: colors.primary }]}>{remaining}</Text>
          </View>
          <View style={[styles.rewardChip, { backgroundColor: colors.primary + "15" }]}>
            <Sparkles size={14} color={colors.primary} />
            <Text style={[styles.rewardChipText, { color: colors.primary }]}>
              {t("ads.simulator.rewardSoon")}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleSkip}
            activeOpacity={0.7}
            style={[styles.skipBtn, { borderColor: colors.border }]}
          >
            <X size={14} color={colors.mutedForeground} />
            <Text style={[styles.skipText, { color: colors.mutedForeground }]}>
              {t("ads.simulator.skip")}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.devNote, { color: colors.mutedForeground }]}>
            {t("ads.simulator.devNote")}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.78)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: 1,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 12,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 18,
  },
  counter: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 4,
  },
  counterText: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    lineHeight: 32,
  },
  rewardChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  rewardChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  skipBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  skipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  devNote: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginTop: 4,
    fontStyle: "italic",
  },
});
