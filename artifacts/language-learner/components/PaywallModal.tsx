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
import { Check, Sparkles, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useT } from "@/utils/i18n";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const FEATURE_KEYS = [
  "paywall.feature.unlimited",
  "paywall.feature.scoring",
  "paywall.feature.noAds",
  "paywall.feature.early",
  "paywall.feature.support",
] as const;

export function PaywallModal({ visible, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { isPro, upgradeToPro, downgradeToFree } = useApp();
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
            {FEATURE_KEYS.map((key) => (
              <View key={key} style={styles.featureRow}>
                <View
                  style={[styles.checkWrap, { backgroundColor: colors.primary + "18" }]}
                >
                  <Check size={14} color={colors.primary} />
                </View>
                <Text style={[styles.featureText, { color: colors.foreground }]}>
                  {t(key)}
                </Text>
              </View>
            ))}
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
                    {t("paywall.cta.subscribe")}
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
    borderRadius: 16,
    paddingVertical: 6,
    marginTop: 8,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  checkWrap: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  featureText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    lineHeight: 20,
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
});
