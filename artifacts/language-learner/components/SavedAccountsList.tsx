import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Platform,
  Alert,
} from "react-native";
import { Smartphone, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import {
  removeSavedAccount,
  notifySavedAccountsChanged,
  type SavedAccount,
} from "@/utils/savedAccounts";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

export function SavedAccountsList({
  accounts,
  onSelect,
}: {
  accounts: SavedAccount[];
  onSelect: (acc: SavedAccount) => void;
}) {
  const colors = useColors();
  const t = useT();

  if (accounts.length === 0) return null;

  const onRemove = (acc: SavedAccount) => {
    const doRemove = async () => {
      await removeSavedAccount(acc.kind, acc.id);
      notifySavedAccountsChanged();
    };
    const msg = t("auth.savedAccounts.removeConfirm", { name: acc.displayName });
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(msg)) {
        void doRemove();
      }
      return;
    }
    Alert.alert(t("auth.savedAccounts.removeTitle"), msg, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("auth.savedAccounts.remove"),
        style: "destructive",
        onPress: () => void doRemove(),
      },
    ]);
  };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.heading, { color: colors.foreground }]}>
        {t("auth.savedAccounts.title")}
      </Text>
      <View
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        {accounts.map((acc, idx) => {
          const secondary = acc.email || acc.username || "";
          return (
            <View
              key={`${acc.kind}:${acc.id}`}
              style={[
                styles.row,
                idx < accounts.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                },
              ]}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t("auth.savedAccounts.continueAsName", {
                  name: acc.displayName,
                })}
                activeOpacity={0.7}
                onPress={() => onSelect(acc)}
                style={styles.rowMain}
              >
                {acc.imageUrl ? (
                  <Image
                    source={{ uri: acc.imageUrl }}
                    style={[styles.avatar, { backgroundColor: colors.muted }]}
                  />
                ) : (
                  <View
                    style={[styles.avatar, { backgroundColor: colors.primary + "20" }]}
                  >
                    <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                      {initialsOf(acc.displayName)}
                    </Text>
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={[styles.name, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {acc.displayName}
                  </Text>
                  {secondary ? (
                    <Text
                      style={[styles.secondary, { color: colors.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {secondary}
                    </Text>
                  ) : null}
                  {acc.kind === "local" ? (
                    <View
                      style={[
                        styles.badge,
                        { backgroundColor: colors.primary + "15" },
                      ]}
                    >
                      <Smartphone size={10} color={colors.primary} />
                      <Text
                        style={[styles.badgeText, { color: colors.primary }]}
                      >
                        {t("auth.savedAccounts.onThisDevice")}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t("auth.savedAccounts.removeAria", {
                  name: acc.displayName,
                })}
                onPress={() => onRemove(acc)}
                hitSlop={10}
                style={styles.removeBtn}
              >
                <X size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginBottom: 18 },
  heading: { fontSize: 13, fontFamily: "Inter_500Medium" },
  card: { borderWidth: 1, borderRadius: 14, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 15, fontFamily: "Inter_500Medium" },
  secondary: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 1 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  removeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
