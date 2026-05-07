import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  FlatList,
  TouchableOpacity,
  Platform,
} from "react-native";
import { ArrowRight, Check, Globe } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { LANGUAGES } from "@/types";
import { translate, getLanguageDisplayName } from "@/utils/i18n";
import { isRTL, rtlFlipStyle, rtlTextStyle } from "@/utils/rtl";

export function LanguageOnboarding() {
  const colors = useColors();
  const { settings, updateSettings, isLoading } = useApp();
  const [selected, setSelected] = useState<string | null>(null);

  if (isLoading) return null;
  if (settings.onboarded) return null;

  const code = selected ?? settings.nativeLanguage ?? "en-US";
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(code, key, params);
  const previewRTL = isRTL(code);

  const handleConfirm = async () => {
    await updateSettings({ nativeLanguage: code, onboarded: true });
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={[styles.overlay, { backgroundColor: colors.background }]}>
        <View style={styles.inner}>
          <View style={[styles.iconCircle, { backgroundColor: colors.primary + "20" }]}>
            <Globe size={32} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {t("onboarding.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {t("onboarding.subtitle")}
          </Text>

          <View style={[styles.listCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <FlatList
              data={LANGUAGES}
              keyExtractor={(l) => l.code}
              showsVerticalScrollIndicator={Platform.OS === "web"}
              renderItem={({ item: lang }) => {
                const isSelected = code === lang.code;
                return (
                  <TouchableOpacity
                    onPress={() => setSelected(lang.code)}
                    style={[
                      styles.row,
                      { borderBottomColor: colors.border },
                      isSelected && { backgroundColor: colors.primary + "12" },
                    ]}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          {
                            color: isSelected ? colors.primary : colors.foreground,
                            fontSize: 15,
                            fontFamily: isSelected ? "Inter_600SemiBold" : "Inter_500Medium",
                          },
                          rtlTextStyle(lang.name),
                        ]}
                      >
                        {lang.name}
                      </Text>
                      <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                        {getLanguageDisplayName(lang.code, code)}
                      </Text>
                    </View>
                    {isSelected && <Check size={18} color={colors.primary} />}
                  </TouchableOpacity>
                );
              }}
            />
          </View>

          <TouchableOpacity
            onPress={handleConfirm}
            style={[styles.continueBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Text style={styles.continueText}>{t("onboarding.continue")}</Text>
            <ArrowRight size={18} color="#fff" style={previewRTL ? rtlFlipStyle : undefined} />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 80,
    paddingBottom: 30,
  },
  inner: {
    flex: 1,
    alignItems: "center",
    gap: 12,
    maxWidth: 460,
    width: "100%",
    alignSelf: "center",
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 19,
    paddingHorizontal: 8,
  },
  listCard: {
    flex: 1,
    width: "100%",
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
    marginTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  continueBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    width: "100%",
  },
  continueText: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
});
