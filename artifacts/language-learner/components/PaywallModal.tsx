import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ban, Infinity as InfinityIcon, Lightbulb, Sparkles, X } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useT } from "@/utils/i18n";

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Only list features that the free tier *actually* differs on today. Each
// entry here is enforced somewhere in the app (see "Pro feature gates" in
// `context/AppContext.tsx`):
//   - `unlimited`: gated by `canCreateArticle()` / daily generation quota.
//   - `noAds`: a side-effect of `isPro` short-circuiting every rewarded-ad
//     path (generation quota wall, dictation listen quota,
//     per-result analysis unlock).
//   - `hints`: gated by the daily dictation-hint counter — Pro users get
//     unlimited hints with no rewarded-video prompt.
// Aspirational selling points (high-quality scoring, early access, "support
// indie") were removed in Task #38 to keep marketing copy honest. Add them
// back here only after the corresponding gate ships.
interface PaywallFeature {
  key: string;
  icon: LucideIcon;
  titleKey: string;
  descKey: string;
}
const FEATURES: readonly PaywallFeature[] = [
  {
    key: "unlimited",
    icon: InfinityIcon,
    titleKey: "paywall.feature.unlimited.title",
    descKey: "paywall.feature.unlimited.desc",
  },
  {
    key: "noAds",
    icon: Ban,
    titleKey: "paywall.feature.noAds.title",
    descKey: "paywall.feature.noAds.desc",
  },
  {
    key: "hints",
    icon: Lightbulb,
    titleKey: "paywall.feature.hints.title",
    descKey: "paywall.feature.hints.desc",
  },
] as const;

export function PaywallModal({ visible, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const router = useRouter();
  const { isPro, isGuest, isLocalAccount, upgradeToPro, downgradeToFree } = useApp();
  // Brief spinner on the primary CTA so the demo "subscribe" tap reads as
  // a deliberate action rather than an instant state flip.
  const [busy, setBusy] = useState(false);

  // If the modal is reopened while in a different tier, clear any stale busy
  // state from the previous open.
  useEffect(() => {
    if (visible) setBusy(false);
  }, [visible]);

  const topPad = Platform.OS === "web" ? 28 : insets.top + 12;

  const handleSubscribe = async () => {
    if (busy) return;
    // Guests and local accounts can't subscribe — Pro state requires a
    // cloud-linked Clerk account. Funnel them to sign-in so the upgrade
    // attaches to a real account that syncs across devices.
    if (isGuest || isLocalAccount) {
      onClose();
      router.push("/(auth)/sign-in");
      return;
    }
    setBusy(true);
    try {
      await upgradeToPro();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await downgradeToFree();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad }]}>
          <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <X size={22} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 24 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.heroIcon, { backgroundColor: colors.primary + "20" }]}>
            <Sparkles size={36} color={colors.primary} />
          </View>

          <Text style={[styles.title, { color: colors.foreground }]}>
            {t("paywall.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {isPro ? t("paywall.pro.subtitle") : t("paywall.subtitle")}
          </Text>

          {isPro ? (
            <View
              style={[
                styles.proBadgeCard,
                { backgroundColor: colors.primary + "12", borderColor: colors.primary + "55" },
              ]}
            >
              <Sparkles size={20} color={colors.primary} />
              <Text style={[styles.proBadgeText, { color: colors.primary }]}>
                {t("paywall.pro.title")}
              </Text>
            </View>
          ) : null}

          <View
            style={[
              styles.featuresCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {FEATURES.map((feature, idx) => {
              const Icon = feature.icon;
              const isLast = idx === FEATURES.length - 1;
              return (
                <View
                  key={feature.key}
                  style={[
                    styles.featureRow,
                    !isLast && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.featureIconWrap,
                      { backgroundColor: colors.primary + "1A" },
                    ]}
                  >
                    <Icon size={20} color={colors.primary} />
                  </View>
                  <View style={styles.featureTextWrap}>
                    <Text
                      style={[styles.featureTitle, { color: colors.foreground }]}
                    >
                      {t(feature.titleKey)}
                    </Text>
                    <Text
                      style={[
                        styles.featureDesc,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      {t(feature.descKey)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>

          {!isPro ? (
            <View style={styles.priceBlock}>
              <Text style={[styles.price, { color: colors.foreground }]}>
                {t("paywall.price")}
              </Text>
              <Text style={[styles.priceNote, { color: colors.mutedForeground }]}>
                {t("paywall.priceNote")}
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <View
          style={[
            styles.footer,
            {
              borderTopColor: colors.border,
              paddingBottom: insets.bottom + 16,
              backgroundColor: colors.background,
            },
          ]}
        >
          {isPro ? (
            <>
              <TouchableOpacity
                onPress={onClose}
                disabled={busy}
                activeOpacity={0.85}
                style={[
                  styles.primaryBtn,
                  { backgroundColor: colors.primary },
                  busy && { opacity: 0.5 },
                ]}
              >
                <Text
                  style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
                >
                  {t("paywall.pro.close")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCancel}
                disabled={busy}
                activeOpacity={0.85}
                style={styles.secondaryBtn}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.destructive} />
                ) : (
                  <Text
                    style={[styles.secondaryBtnText, { color: colors.destructive }]}
                  >
                    {t("paywall.pro.cancel")}
                  </Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              {isGuest ? (
                <Text
                  style={[styles.guestNote, { color: colors.mutedForeground }]}
                >
                  {t("paywall.guest.note")}
                </Text>
              ) : null}
              <TouchableOpacity
                onPress={handleSubscribe}
                disabled={busy}
                activeOpacity={0.85}
                style={[
                  styles.primaryBtn,
                  { backgroundColor: colors.primary },
                  busy && { opacity: 0.6 },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text
                    style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
                  >
                    {isGuest
                      ? t("paywall.cta.signInToSubscribe")
                      : t("paywall.cta.subscribe")}
                  </Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onClose}
                disabled={busy}
                activeOpacity={0.85}
                style={styles.secondaryBtn}
              >
                <Text
                  style={[
                    styles.secondaryBtnText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {t("paywall.cta.later")}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 4,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  closeBtn: { padding: 6 },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
    alignItems: "center",
    gap: 12,
  },
  heroIcon: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
    maxWidth: 320,
    marginBottom: 8,
  },
  proBadgeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  proBadgeText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  featuresCard: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 4,
    marginTop: 8,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  featureIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  featureTextWrap: {
    flex: 1,
    gap: 3,
  },
  featureTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 20,
  },
  featureDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  priceBlock: {
    alignItems: "center",
    marginTop: 16,
    gap: 4,
  },
  price: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  priceNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  primaryBtn: {
    height: 50,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  secondaryBtn: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  guestNote: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 18,
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
});
