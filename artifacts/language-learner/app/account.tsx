import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Platform,
  Alert,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth, useUser, useClerk } from "@clerk/expo";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useT } from "@/utils/i18n";

type AccountModalKind = "username" | "password" | null;

export default function AccountScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { activeLocalAccount, switchLocalAccount } = useApp();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [accountModal, setAccountModal] = useState<AccountModalKind>(null);

  const topPad = Platform.OS === "web" ? 16 : insets.top;

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/settings");
  };

  const confirmSignOut = () => {
    const doSignOut = async () => {
      try {
        await signOut();
      } catch {
        // ignore
      }
    };
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(t("auth.signOut.confirmMsg"))) {
        doSignOut();
      }
      return;
    }
    Alert.alert(t("auth.signOut.title"), t("auth.signOut.confirmMsg"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("auth.signOut.title"), style: "destructive", onPress: doSignOut },
    ]);
  };

  const exitLocalAccount = async () => {
    await switchLocalAccount(null);
  };

  const hasPasswordCredential = !!user?.passwordEnabled;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 8, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {t("settings.section.account")}
        </Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: insets.bottom + 32,
          gap: 18,
        }}
      >
        <View
          style={[
            styles.sectionCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          {!authLoaded ? (
            <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text style={[styles.itemDesc, { color: colors.mutedForeground, marginLeft: 8 }]}>
                …
              </Text>
            </View>
          ) : isSignedIn && user ? (
            <>
              <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="user" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]} numberOfLines={1}>
                    {user.username || user.fullName || user.primaryEmailAddress?.emailAddress || t("auth.account.signedIn")}
                  </Text>
                  {user.primaryEmailAddress?.emailAddress ? (
                    <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {user.primaryEmailAddress.emailAddress}
                    </Text>
                  ) : null}
                </View>
              </View>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => setAccountModal("username")}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="edit-3" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                    {t("auth.username.change")}
                  </Text>
                </View>
                <Text style={[styles.itemValue, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {user.username || ""}
                </Text>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
              {hasPasswordCredential && (
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => setAccountModal("password")}
                  style={[styles.itemRow, { borderBottomColor: colors.border }]}
                >
                  <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                    <Feather name="lock" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                      {t("auth.password.change")}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={confirmSignOut}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.destructive + "15" }]}>
                  <Feather name="log-out" size={16} color={colors.destructive} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.destructive }]}>
                    {t("auth.signOut.title")}
                  </Text>
                </View>
              </TouchableOpacity>
            </>
          ) : activeLocalAccount ? (
            <>
              <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="user" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]} numberOfLines={1}>
                    {activeLocalAccount.name}
                  </Text>
                  <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {t("auth.local.activeLabel")}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/(auth)/local")}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="users" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                    {t("auth.local.manage")}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/(auth)/sign-in")}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="log-in" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                    {t("auth.signIn.title")}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={exitLocalAccount}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.destructive + "15" }]}>
                  <Feather name="log-out" size={16} color={colors.destructive} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.destructive }]}>
                    {t("auth.local.exit")}
                  </Text>
                </View>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/(auth)/sign-in")}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="log-in" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                    {t("auth.signIn.title")}
                  </Text>
                  <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                    {t("auth.account.guestHint")}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/(auth)/sign-up")}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="user-plus" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                    {t("auth.signUp.title")}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => router.push("/(auth)/local")}
                style={[styles.itemRow, { borderBottomColor: colors.border }]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <Feather name="users" size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemLabel, { color: colors.foreground }]}>
                    {t("auth.local.use")}
                  </Text>
                  <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                    {t("auth.local.useHint")}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>

      <AccountEditModal
        kind={accountModal}
        onClose={() => setAccountModal(null)}
        colors={colors}
      />
    </View>
  );
}

function AccountEditModal({
  kind,
  onClose,
  colors,
}: {
  kind: AccountModalKind;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const t = useT();
  const { user } = useUser();
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  React.useEffect(() => {
    if (kind === "username") setUsername(user?.username ?? "");
    if (kind === null) {
      setUsername("");
      setCurrentPassword("");
      setNewPassword("");
      setError(null);
      setOkMsg(null);
      setBusy(false);
    }
  }, [kind, user?.username]);

  const close = () => {
    if (busy) return;
    onClose();
  };

  const submitUsername = async () => {
    if (!user) return;
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      await user.update({ username: username.trim() });
      setOkMsg(t("auth.username.changed"));
      setTimeout(() => onClose(), 600);
    } catch (e: any) {
      setError(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || e?.message || t("auth.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!user) return;
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      await user.updatePassword({
        currentPassword,
        newPassword,
        signOutOfOtherSessions: true,
      });
      setOkMsg(t("auth.password.changed"));
      setTimeout(() => onClose(), 600);
    } catch (e: any) {
      setError(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || e?.message || t("auth.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const isUsername = kind === "username";
  const isPassword = kind === "password";

  return (
    <Modal visible={kind !== null} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
        <View style={[modalCardStyles.card, { backgroundColor: colors.card }]}>
          <Text style={[modalCardStyles.title, { color: colors.foreground }]}>
            {isUsername ? t("auth.username.change") : t("auth.password.change")}
          </Text>

          {isUsername && (
            <>
              <Text style={[modalCardStyles.label, { color: colors.foreground }]}>
                {t("auth.username")}
              </Text>
              <TextInput
                value={username}
                onChangeText={setUsername}
                placeholder={t("auth.username.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                style={[
                  modalCardStyles.input,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground },
                ]}
              />
            </>
          )}

          {isPassword && (
            <>
              <Text style={[modalCardStyles.label, { color: colors.foreground }]}>
                {t("auth.password.current")}
              </Text>
              <TextInput
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder={t("auth.password.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry
                style={[
                  modalCardStyles.input,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground },
                ]}
              />
              <Text style={[modalCardStyles.label, { color: colors.foreground, marginTop: 4 }]}>
                {t("auth.password.new")}
              </Text>
              <TextInput
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder={t("auth.password.placeholderNew")}
                placeholderTextColor={colors.mutedForeground}
                secureTextEntry
                style={[
                  modalCardStyles.input,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground },
                ]}
              />
            </>
          )}

          {error ? (
            <Text style={{ color: colors.destructive, fontSize: 12 }}>{error}</Text>
          ) : null}
          {okMsg ? (
            <Text style={{ color: colors.primary, fontSize: 12 }}>{okMsg}</Text>
          ) : null}

          <View style={modalCardStyles.actions}>
            <TouchableOpacity
              onPress={close}
              disabled={busy}
              style={[modalCardStyles.btn, { backgroundColor: colors.muted }]}
              activeOpacity={0.8}
            >
              <Text style={[modalCardStyles.btnText, { color: colors.foreground }]}>
                {t("common.cancel")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={isUsername ? submitUsername : submitPassword}
              disabled={
                busy ||
                (isUsername && !username.trim()) ||
                (isPassword && (!currentPassword || !newPassword))
              }
              style={[
                modalCardStyles.btn,
                { backgroundColor: colors.primary },
                (busy ||
                  (isUsername && !username.trim()) ||
                  (isPassword && (!currentPassword || !newPassword))) && { opacity: 0.5 },
              ]}
              activeOpacity={0.8}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={[modalCardStyles.btnText, { color: "#fff" }]}>
                  {t("common.save")}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  sectionCard: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  itemLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  itemDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    lineHeight: 16,
  },
  itemValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    maxWidth: 160,
    textAlign: "right",
  },
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
});

const modalCardStyles = StyleSheet.create({
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 6,
  },
  btn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
    minWidth: 80,
    alignItems: "center",
  },
  btnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
