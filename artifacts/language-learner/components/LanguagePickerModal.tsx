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
import { useApp } from "@/context/AppContext";
import { getLanguageDisplayName } from "@/utils/i18n";
import { LANGUAGES } from "@/types";
import { Flag } from "@/utils/flags";
import { rtlTextStyle } from "@/utils/rtl";

interface Props {
  visible: boolean;
  title: string;
  selected: string;
  onSelect: (code: string) => void;
  onClose: () => void;
  showFlags?: boolean;
  excludeCode?: string;
}

export function LanguagePickerModal({
  visible,
  title,
  selected,
  onSelect,
  onClose,
  showFlags = false,
  excludeCode,
}: Props) {
  const colors = useColors();
  const { settings } = useApp();
  const uiLocale = settings.nativeLanguage;

  const languages = LANGUAGES
    .filter((l) => l.code !== excludeCode)
    .slice()
    .sort((a, b) => a.english.localeCompare(b.english));

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
            styles.card,
            { backgroundColor: colors.card },
          ]}
        >
          <View
            style={[
              styles.header,
              { borderBottomColor: colors.border },
            ]}
          >
            <Text style={[styles.title, { color: colors.foreground }]}>
              {title}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={languages}
            keyExtractor={(l) => l.code}
            style={{ maxHeight: 420 }}
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
                    isSelected && { backgroundColor: colors.primary + "15" },
                  ]}
                  activeOpacity={0.7}
                >
                  {showFlags && (
                    <View style={styles.flagWrap}>
                      <Flag code={lang.code} size={22} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        {
                          color: isSelected
                            ? colors.primary
                            : colors.foreground,
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
                  {isSelected && (
                    <Check size={18} color={colors.primary} />
                  )}
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
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  card: {
    width: "100%",
    maxWidth: 460,
    borderRadius: 16,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  flagWrap: {
    width: 26,
    alignItems: "center",
  },
});
