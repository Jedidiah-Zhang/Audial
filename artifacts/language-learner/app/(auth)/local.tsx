import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
  Alert,
  Modal,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Edit2, Plus, Trash2, User, Users, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { useApp, type LocalAccount } from "@/context/AppContext";
import { useSavedAccounts } from "@/hooks/useSavedAccounts";
import { SavedAccountsList } from "@/components/SavedAccountsList";
import type { SavedAccount } from "@/utils/savedAccounts";
import { useAuth, useSessionList } from "@clerk/expo";

export default function LocalAccountsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const {
    localAccounts,
    activeLocalAccountId,
    createLocalAccount,
    switchLocalAccount,
    deleteLocalAccount,
    renameLocalAccount,
    updateSettings,
  } = useApp();

  const savedAccounts = useSavedAccounts();
  const { isSignedIn } = useAuth();
  const { sessions: cachedSessions, setActive: setActiveSession } = useSessionList();

  const [name, setName] = useState("");
  const [renameTarget, setRenameTarget] = useState<LocalAccount | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Tap handler for the unified "Continue as…" picker shown on this
  // screen. Local profiles switch in-place; Clerk accounts try to
  // fast-switch via a cached session, otherwise fall through to the
  // sign-in screen so the user can authenticate.
  const onSavedAccountTap = async (acc: SavedAccount) => {
    if (acc.kind === "local") {
      await updateSettings({ onboarded: true });
      await switchLocalAccount(acc.id);
      router.replace("/(tabs)");
      return;
    }
    // Don't try to fast-switch into another Clerk session while one is
    // already active — Clerk's `setActive` would still work, but most
    // users on this screen reached it via "manage local profiles" while
    // signed-out, so this branch is mostly for the rare cached case.
    if (!isSignedIn) {
      const cached = (cachedSessions ?? []).find(
        (s) => s.user?.id === acc.id && s.status === "active",
      );
      if (cached && setActiveSession) {
        try {
          await setActiveSession({
            session: cached.id,
            navigate: () => router.replace("/(tabs)"),
          });
          return;
        } catch {
          // Fall through to the sign-in screen.
        }
      }
    }
    // Pass the saved account hint along so the sign-in screen can
    // pre-fill the identifier and highlight the matching SSO button —
    // without this, tapping a Clerk row from the manage screen would
    // dump the user into a blank form, which is slower than the
    // experience the picker promises elsewhere.
    router.push({
      pathname: "/(auth)/sign-in",
      params: {
        identifier: acc.email || acc.username || "",
        sso: acc.lastMethod === "google" || acc.lastMethod === "microsoft" ? acc.lastMethod : "",
      },
    });
  };

  const onCreate = async () => {
    const v = name.trim();
    if (!v) return;
    // Mark first-launch as complete before flipping to the new local
    // profile. createLocalAccount pre-seeds the new scope with the
    // current language + onboarded:true, but the previous (guest)
    // scope still needs the flag set so a sign-out back to it doesn't
    // bounce the user back to the auth gate.
    await updateSettings({ onboarded: true });
    await createLocalAccount(v);
    setName("");
    router.replace("/(tabs)");
  };

  const onSwitch = async (id: string) => {
    await updateSettings({ onboarded: true });
    await switchLocalAccount(id);
    router.replace("/(tabs)");
  };

  const onDelete = (acc: LocalAccount) => {
    const doDelete = async () => {
      await deleteLocalAccount(acc.id);
    };
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(t("auth.local.deleteMsg", { name: acc.name }))) {
        doDelete();
      }
      return;
    }
    Alert.alert(
      t("auth.local.delete"),
      t("auth.local.deleteMsg", { name: acc.name }),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("common.delete"), style: "destructive", onPress: doDelete },
      ]
    );
  };

  const openRename = (acc: LocalAccount) => {
    setRenameTarget(acc);
    setRenameValue(acc.name);
  };

  const closeRename = () => {
    setRenameTarget(null);
    setRenameValue("");
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    await renameLocalAccount(renameTarget.id, renameValue);
    closeRename();
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
          <X size={22} color={colors.foreground} />
        </TouchableOpacity>

        <View style={styles.heroBox}>
          <View style={[styles.logo, { backgroundColor: colors.primary + "20" }]}>
            <Users size={28} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>{t("auth.local.title")}</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {t("auth.local.subtitle")}
          </Text>
        </View>

        {savedAccounts.length > 0 && (
          <SavedAccountsList accounts={savedAccounts} onSelect={onSavedAccountTap} />
        )}

        <View style={{ gap: 8, marginTop: 8 }}>
          <Text style={[styles.label, { color: colors.foreground }]}>
            {t("auth.local.create")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t("auth.local.namePlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.input,
                {
                  flex: 1,
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              returnKeyType="done"
              onSubmitEditing={onCreate}
            />
            <TouchableOpacity
              onPress={onCreate}
              disabled={!name.trim()}
              style={[
                styles.primaryBtn,
                { backgroundColor: colors.primary },
                !name.trim() && { opacity: 0.5 },
              ]}
              activeOpacity={0.85}
            >
              <Plus size={18} color={colors.primaryForeground} />
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ marginTop: 28, gap: 8 }}>
          <Text style={[styles.label, { color: colors.foreground }]}>
            {t("auth.local.section")}
          </Text>
          <View
            style={[
              styles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            {localAccounts.length === 0 ? (
              <Text
                style={{
                  padding: 16,
                  color: colors.mutedForeground,
                  fontSize: 14,
                  fontFamily: "Inter_400Regular",
                  textAlign: "center",
                }}
              >
                {t("auth.local.empty")}
              </Text>
            ) : (
              localAccounts.map((acc, idx) => {
                const active = acc.id === activeLocalAccountId;
                return (
                  <View
                    key={acc.id}
                    style={[
                      styles.row,
                      idx < localAccounts.length - 1 && {
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.border,
                      },
                    ]}
                  >
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => onSwitch(acc.id)}
                      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12 }}
                    >
                      <View
                        style={[
                          styles.avatar,
                          { backgroundColor: colors.primary + (active ? "30" : "15") },
                        ]}
                      >
                        <User size={16} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={{
                            color: colors.foreground,
                            fontSize: 15,
                            fontFamily: "Inter_500Medium",
                          }}
                        >
                          {acc.name}
                        </Text>
                        {active && (
                          <Text
                            style={{
                              color: colors.primary,
                              fontSize: 12,
                              fontFamily: "Inter_500Medium",
                              marginTop: 2,
                            }}
                          >
                            {t("auth.local.activeLabel")}
                          </Text>
                        )}
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => openRename(acc)}
                      hitSlop={10}
                      style={{ padding: 6 }}
                    >
                      <Edit2 size={16} color={colors.mutedForeground} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onDelete(acc)}
                      hitSlop={10}
                      style={{ padding: 6 }}
                    >
                      <Trash2 size={16} color={colors.destructive} />
                    </TouchableOpacity>
                  </View>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={!!renameTarget}
        transparent
        animationType="fade"
        onRequestClose={closeRename}
      >
        <View style={modalStyles.overlay}>
          <TouchableOpacity
            style={modalStyles.backdrop}
            activeOpacity={1}
            onPress={closeRename}
          />
          <View style={[modalStyles.card, { backgroundColor: colors.card }]}>
            <Text style={[modalStyles.title, { color: colors.foreground }]}>
              {t("auth.local.rename")}
            </Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              placeholder={t("auth.local.namePlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.input,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              returnKeyType="done"
              onSubmitEditing={confirmRename}
            />
            <View style={modalStyles.actions}>
              <TouchableOpacity
                onPress={closeRename}
                style={[modalStyles.btn, { backgroundColor: colors.muted }]}
                activeOpacity={0.8}
              >
                <Text style={[modalStyles.btnText, { color: colors.foreground }]}>
                  {t("common.cancel")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmRename}
                style={[modalStyles.btn, { backgroundColor: colors.primary }]}
                activeOpacity={0.8}
              >
                <Text style={[modalStyles.btnText, { color: "#fff" }]}>
                  {t("common.save")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, gap: 8 },
  backBtn: { alignSelf: "flex-start", padding: 6, marginBottom: 4 },
  heroBox: { alignItems: "center", marginTop: 8, marginBottom: 24, gap: 8 },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", textAlign: "center" },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    maxWidth: 320,
    lineHeight: 20,
  },
  label: { fontSize: 13, fontFamily: "Inter_500Medium" },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 14 : 11,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  primaryBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  title: { fontSize: 16, fontFamily: "Inter_600SemiBold" },
  actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  btn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 8 },
  btnText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
