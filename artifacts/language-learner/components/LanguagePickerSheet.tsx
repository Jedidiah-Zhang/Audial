import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  FlatList,
  TouchableOpacity,
  Platform,
} from "react-native";
import { Check, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT, getLanguageDisplayName } from "@/utils/i18n";
import { useApp } from "@/context/AppContext";
import { LANGUAGES } from "@/types";
import { rtlTextStyle } from "@/utils/rtl";

interface Props {
  visible: boolean;
  selected: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}

/**
 * Modal language picker reused from the auth screens (sign-in, sign-up,
 * local accounts) so a brand-new user can switch the UI language before
 * they have an account. Mirrors the look-and-feel of the in-settings
 * language picker but lives outside any screen-specific state, so it can
 * be mounted anywhere updateSettings() is in scope.
 */
export function LanguagePickerSheet({
  visible,
  selected,
  onSelect,
  onClose,
}: Props) {
  const colors = useColors();
  const t = useT();
  const { settings } = useApp();
  const uiLocale = settings.nativeLanguage;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.background, borderColor: colors.border },
          ]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t("auth.language.pickerTitle")}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={{ padding: 4 }}>
              <X size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={LANGUAGES}
            keyExtractor={(l) => l.code}
            showsVerticalScrollIndicator={Platform.OS === "web"}
            renderItem={({ item: lang }) => {
              const isSelected = selected === lang.code;
              return (
                <TouchableOpacity
                  onPress={() => {
                    onSelect(lang.code);
                    onClose();
                  }}
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
                          fontFamily: isSelected
                            ? "Inter_600SemiBold"
                            : "Inter_500Medium",
                        },
                        rtlTextStyle(lang.name),
                      ]}
                    >
                      {lang.name}
                    </Text>
                    <Text
                      style={{
                        color: colors.mutedForeground,
                        fontSize: 12,
                        marginTop: 1,
                      }}
                    >
                      {getLanguageDisplayName(lang.code, uiLocale)}
                    </Text>
                  </View>
                  {isSelected && <Check size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    height: "75%",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
