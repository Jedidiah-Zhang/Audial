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
import { ChevronLeft, ChevronRight, User } from "lucide-react-native";
import { flipIfRTL } from "@/utils/rtl";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useAuth, useUser, useClerk } from "@clerk/expo";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useT } from "@/utils/i18n";
import { Icon, type IconName } from "@/components/Icon";

type AccountModalKind = "username" | "password" | null;
type TwoFactorModalKind =
  | { kind: "enable" }
  | { kind: "backupCodes"; codes: string[] }
  | null;

// Narrow shape of the Clerk methods we touch for 2FA. Keeps us off
// the public `as any` escape hatch while still tolerating Clerk SDK
// versions where these methods are typed as optional / unknown.
type ClerkEmailFor2FA = {
  id: string;
  emailAddress: string;
  verification?: { status?: string };
  reservedForSecondFactor?: boolean;
  prepareVerification?: (args: { strategy: "email_code" }) => Promise<unknown>;
  attemptVerification?: (args: { code: string }) => Promise<unknown>;
  setReservedForSecondFactor?: (args: { reserved: boolean }) => Promise<unknown>;
};

type ClerkBackupCodeResource = { codes?: string[] };

type ClerkUserFor2FA = {
  twoFactorEnabled?: boolean;
  emailAddresses?: ClerkEmailFor2FA[];
  primaryEmailAddress?: ClerkEmailFor2FA | null;
  reload: () => Promise<unknown>;
  createBackupCode?: () => Promise<ClerkBackupCodeResource>;
};

export default function AccountScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { activeLocalAccount, switchLocalAccount } = useApp();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const { signOut } = clerk;
  const [accountModal, setAccountModal] = useState<AccountModalKind>(null);
  const [twoFactorModal, setTwoFactorModal] = useState<TwoFactorModalKind>(null);

  // We previously gated the "change username" row on a Clerk
  // `__unstable__environment.userSettings.attributes.username.enabled`
  // probe, but that internal snapshot is often empty after hydration
  // which made the row silently disappear even when the project does
  // allow usernames. Always show the row; if Clerk's API rejects the
  // update (e.g. usernames disabled at the project level) the modal
  // already surfaces a friendly "this account doesn't support changing
  // username" message via the looksLikeUnsupported branch.

  const topPad = Platform.OS === "web" ? 67 : insets.top;

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
      <View style={[styles.header, { paddingTop: topPad + 16 }]}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={10}>
          <ChevronLeft size={26} color={colors.foreground} style={flipIfRTL()} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {t("settings.section.account")}
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 32,
          gap: 18,
        }}
        showsVerticalScrollIndicator={Platform.OS === "web"}
      >
        {!authLoaded ? (
          <Section title={t("settings.section.account")} colors={colors}>
            <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
              <ActivityIndicator size="small" color={colors.mutedForeground} />
              <Text style={[styles.itemDesc, { color: colors.mutedForeground, marginLeft: 8 }]}>
                …
              </Text>
            </View>
          </Section>
        ) : isSignedIn && user ? (
          <>
            <Section title={t("auth.account.signedIn")} colors={colors}>
              <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <User size={16} color={colors.primary} />
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
              <Row
                colors={colors}
                icon="edit-3"
                label={t("auth.username.change")}
                value={user.username || ""}
                onPress={() => setAccountModal("username")}
              />
              {hasPasswordCredential && (
                <Row
                  colors={colors}
                  icon="lock"
                  label={t("auth.password.change")}
                  onPress={() => setAccountModal("password")}
                />
              )}
            </Section>
            <TwoFactorSection
              colors={colors}
              t={t}
              onEnablePress={() => setTwoFactorModal({ kind: "enable" })}
              onShowBackupCodes={(codes) =>
                setTwoFactorModal({ kind: "backupCodes", codes })
              }
            />
            <Section title={t("settings.section.account")} colors={colors}>
              <DangerRow
                colors={colors}
                icon="log-out"
                label={t("auth.signOut.title")}
                onPress={confirmSignOut}
              />
            </Section>
          </>
        ) : activeLocalAccount ? (
          <>
            <Section title={t("auth.local.activeLabel")} colors={colors}>
              <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
                  <User size={16} color={colors.primary} />
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
              <Row
                colors={colors}
                icon="users"
                label={t("auth.local.manage")}
                onPress={() => router.push("/(auth)/local")}
              />
              <Row
                colors={colors}
                icon="log-in"
                label={t("auth.signIn.title")}
                onPress={() => router.push("/(auth)/sign-in")}
              />
            </Section>
            <Section title={t("settings.section.account")} colors={colors}>
              <DangerRow
                colors={colors}
                icon="log-out"
                label={t("auth.local.exit")}
                onPress={exitLocalAccount}
              />
            </Section>
          </>
        ) : (
          <Section title={t("auth.account.notSignedIn")} colors={colors}>
            <RowWithDesc
              colors={colors}
              icon="log-in"
              label={t("auth.signIn.title")}
              description={t("auth.account.guestHint")}
              onPress={() => router.push("/(auth)/sign-in")}
            />
            <Row
              colors={colors}
              icon="user-plus"
              label={t("auth.signUp.title")}
              onPress={() => router.push("/(auth)/sign-up")}
            />
            <RowWithDesc
              colors={colors}
              icon="users"
              label={t("auth.local.use")}
              description={t("auth.local.useHint")}
              onPress={() => router.push("/(auth)/local")}
            />
          </Section>
        )}
      </ScrollView>

      <AccountEditModal
        kind={accountModal}
        onClose={() => setAccountModal(null)}
        colors={colors}
      />

      <TwoFactorModal
        modal={twoFactorModal}
        onClose={() => setTwoFactorModal(null)}
        onShowBackupCodes={(codes) =>
          setTwoFactorModal({ kind: "backupCodes", codes })
        }
        colors={colors}
      />
    </View>
  );
}

function TwoFactorSection({
  colors,
  t,
  onEnablePress,
  onShowBackupCodes,
}: {
  colors: ReturnType<typeof useColors>;
  t: ReturnType<typeof useT>;
  onEnablePress: () => void;
  onShowBackupCodes: (codes: string[]) => void;
}) {
  const { user: rawUser } = useUser();
  const user = rawUser as unknown as ClerkUserFor2FA | null;
  const [busy, setBusy] = useState<"disable" | "regen" | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!user) return null;
  const enabled = !!user.twoFactorEnabled;
  // Find the email reserved as a 2FA factor (or fall back to primary).
  const emails = user.emailAddresses ?? [];
  const reservedEmail = emails.find((e) => e.reservedForSecondFactor);
  const primaryEmail = user.primaryEmailAddress?.emailAddress;

  const confirmAction = (title: string, message: string, onConfirm: () => void) => {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) {
        onConfirm();
      }
      return;
    }
    Alert.alert(title, message, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.confirm"), style: "destructive", onPress: onConfirm },
    ]);
  };

  const handleRegenerate = () => {
    confirmAction(
      t("auth.twoFactor.confirmRegenTitle"),
      t("auth.twoFactor.confirmRegenMsg"),
      async () => {
        setErrorMsg(null);
        setBusy("regen");
        try {
          if (typeof user.createBackupCode !== "function") {
            throw new Error(t("auth.twoFactor.error.generic"));
          }
          const res = await user.createBackupCode();
          const codes = res?.codes ?? [];
          if (!Array.isArray(codes) || codes.length === 0) {
            throw new Error(t("auth.twoFactor.error.generic"));
          }
          onShowBackupCodes(codes);
        } catch (e) {
          setErrorMsg(formatClerkError(e, t));
        } finally {
          setBusy(null);
        }
      },
    );
  };

  const handleDisable = () => {
    confirmAction(
      t("auth.twoFactor.confirmDisableTitle"),
      t("auth.twoFactor.confirmDisableMsg"),
      async () => {
        setErrorMsg(null);
        setBusy("disable");
        try {
          // Un-reserve every email currently flagged as a second factor.
          const targets = emails.filter((e) => e.reservedForSecondFactor);
          for (const e of targets) {
            if (typeof e.setReservedForSecondFactor === "function") {
              await e.setReservedForSecondFactor({ reserved: false });
            }
          }
          await user.reload();
        } catch (e) {
          setErrorMsg(formatClerkError(e, t));
        } finally {
          setBusy(null);
        }
      },
    );
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
        {t("auth.twoFactor.section").toUpperCase()}
      </Text>
      <View
        style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
          <View
            style={[
              styles.iconWrap,
              {
                backgroundColor:
                  (enabled ? colors.primary : colors.mutedForeground) + "15",
              },
            ]}
          >
            <Icon
              name="shield"
              size={16}
              color={enabled ? colors.primary : colors.mutedForeground}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.itemLabel, { color: colors.foreground }]}>
              {enabled
                ? t("auth.twoFactor.statusOnEmail")
                : t("auth.twoFactor.statusOff")}
            </Text>
            <Text
              style={[styles.itemDesc, { color: colors.mutedForeground }]}
              numberOfLines={2}
            >
              {enabled
                ? reservedEmail?.emailAddress || primaryEmail || t("auth.twoFactor.enabled")
                : t("auth.twoFactor.subtitle")}
            </Text>
          </View>
        </View>

        {!enabled ? (
          <Row
            colors={colors}
            icon="shield-check"
            label={t("auth.twoFactor.turnOn")}
            onPress={onEnablePress}
          />
        ) : (
          <>
            <Row
              colors={colors}
              icon="refresh-cw"
              label={
                busy === "regen"
                  ? t("auth.twoFactor.backupGenerating")
                  : t("auth.twoFactor.regenerate")
              }
              onPress={busy ? undefined : handleRegenerate}
            />
            <DangerRow
              colors={colors}
              icon="shield-off"
              label={t("auth.twoFactor.turnOff")}
              onPress={busy ? undefined : handleDisable}
            />
          </>
        )}

        {errorMsg ? (
          <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
            <Text style={{ color: colors.destructive, fontSize: 12 }}>{errorMsg}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

type ClerkAPIErrorShape = {
  code?: string;
  message?: string;
  longMessage?: string;
};

function formatClerkError(e: unknown, t: ReturnType<typeof useT>): string {
  const errObj = (e ?? {}) as { errors?: unknown; message?: string };
  const rawErrs = Array.isArray(errObj.errors) ? errObj.errors : [];
  const errs = rawErrs as ClerkAPIErrorShape[];
  const first = errs[0];
  const code = first?.code ?? "";
  const haystack = [
    code,
    first?.longMessage,
    first?.message,
    errObj.message,
  ]
    .filter(Boolean)
    .join(" | ");
  if (
    /feature[_ ]?not[_ ]?enabled|not_enabled|second[_ ]?factor.*disabled|backup_code.*not.*enabled/i.test(
      haystack,
    ) ||
    code === "feature_not_enabled"
  ) {
    return t("auth.twoFactor.featureDisabled");
  }
  return (
    first?.longMessage || first?.message || errObj.message || t("auth.twoFactor.error.generic")
  );
}

function TwoFactorModal({
  modal,
  onClose,
  onShowBackupCodes,
  colors,
}: {
  modal: TwoFactorModalKind;
  onClose: () => void;
  onShowBackupCodes: (codes: string[]) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const t = useT();
  const { user: rawUser } = useUser();
  const user = rawUser as unknown as ClerkUserFor2FA | null;
  const [step, setStep] = useState<"intro" | "code">("intro");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const isEnable = modal?.kind === "enable";
  const isBackup = modal?.kind === "backupCodes";

  React.useEffect(() => {
    if (modal === null) {
      setStep("intro");
      setCode("");
      setBusy(false);
      setError(null);
      setInfo(null);
      setCopied(false);
      setAcknowledged(false);
    }
  }, [modal]);

  const targetEmail: ClerkEmailFor2FA | null = (() => {
    if (!user) return null;
    const primary = user.primaryEmailAddress;
    if (primary?.verification?.status === "verified") return primary;
    const emails = user.emailAddresses ?? [];
    return emails.find((e) => e.verification?.status === "verified") ?? null;
  })();

  const close = () => {
    if (busy) return;
    if (isBackup && !acknowledged) return;
    onClose();
  };

  const sendCode = async () => {
    if (!targetEmail) {
      setError(t("auth.twoFactor.noEmail"));
      return;
    }
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (typeof targetEmail.prepareVerification !== "function") {
        throw new Error(t("auth.twoFactor.error.generic"));
      }
      await targetEmail.prepareVerification({ strategy: "email_code" });
      setInfo(
        t("auth.twoFactor.codeSent", { email: targetEmail.emailAddress }),
      );
      setStep("code");
    } catch (e) {
      setError(formatClerkError(e, t));
    } finally {
      setBusy(false);
    }
  };

  const verifyAndEnable = async () => {
    if (!user || !targetEmail) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (typeof targetEmail.attemptVerification === "function") {
        await targetEmail.attemptVerification({ code: trimmed });
      }
      if (typeof targetEmail.setReservedForSecondFactor !== "function") {
        throw new Error(t("auth.twoFactor.error.generic"));
      }
      await targetEmail.setReservedForSecondFactor({ reserved: true });
      // Generate first set of backup codes immediately and pivot the
      // modal into the backup-codes screen.
      if (typeof user.createBackupCode !== "function") {
        throw new Error(t("auth.twoFactor.error.generic"));
      }
      const res = await user.createBackupCode();
      const codes = res?.codes ?? [];
      await user.reload();
      if (!Array.isArray(codes) || codes.length === 0) {
        // 2FA is on but we couldn't get backup codes — surface so the
        // user knows to retry from the section.
        onClose();
        return;
      }
      onShowBackupCodes(codes);
    } catch (e) {
      setError(formatClerkError(e, t));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!isBackup) return;
    try {
      await Clipboard.setStringAsync(modal.codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* best-effort */
    }
  };

  return (
    <Modal visible={modal !== null} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.overlay}
      >
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
        <View style={[modalCardStyles.card, { backgroundColor: colors.card }]}>
          {isEnable && (
            <>
              <Text style={[modalCardStyles.title, { color: colors.foreground }]}>
                {t("auth.twoFactor.enableTitle")}
              </Text>
              {!targetEmail ? (
                <Text style={{ color: colors.destructive, fontSize: 13 }}>
                  {t("auth.twoFactor.noEmail")}
                </Text>
              ) : (
                <Text style={{ color: colors.mutedForeground, fontSize: 13, lineHeight: 18 }}>
                  {t("auth.twoFactor.enableIntro", { email: targetEmail.emailAddress })}
                </Text>
              )}

              {step === "code" && (
                <>
                  <Text style={[modalCardStyles.label, { color: colors.foreground, marginTop: 6 }]}>
                    {t("auth.twoFactor.codeLabel")}
                  </Text>
                  <TextInput
                    value={code}
                    onChangeText={setCode}
                    placeholder={t("auth.twoFactor.codePlaceholder")}
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    keyboardType="number-pad"
                    autoFocus
                    style={[
                      modalCardStyles.input,
                      {
                        backgroundColor: colors.background,
                        borderColor: colors.border,
                        color: colors.foreground,
                        textAlign: "center",
                        letterSpacing: 4,
                      },
                    ]}
                  />
                  <TouchableOpacity onPress={sendCode} disabled={busy} hitSlop={8}>
                    <Text
                      style={{
                        color: colors.primary,
                        fontSize: 13,
                        fontFamily: "Inter_500Medium",
                        marginTop: 4,
                      }}
                    >
                      {t("auth.twoFactor.resend")}
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              {info ? (
                <Text style={{ color: colors.primary, fontSize: 12 }}>{info}</Text>
              ) : null}
              {error ? (
                <Text style={{ color: colors.destructive, fontSize: 12 }}>{error}</Text>
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
                  onPress={step === "intro" ? sendCode : verifyAndEnable}
                  disabled={
                    busy ||
                    !targetEmail ||
                    (step === "code" && !code.trim())
                  }
                  style={[
                    modalCardStyles.btn,
                    { backgroundColor: colors.primary },
                    (busy ||
                      !targetEmail ||
                      (step === "code" && !code.trim())) && { opacity: 0.5 },
                  ]}
                  activeOpacity={0.8}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={[modalCardStyles.btnText, { color: "#fff" }]}>
                      {step === "intro"
                        ? t("auth.twoFactor.sendCode")
                        : t("auth.twoFactor.verify")}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}

          {isBackup && (
            <>
              <Text style={[modalCardStyles.title, { color: colors.foreground }]}>
                {t("auth.twoFactor.backupTitle")}
              </Text>
              <Text style={{ color: colors.destructive, fontSize: 13, lineHeight: 18 }}>
                {t("auth.twoFactor.backupWarning")}
              </Text>
              <View
                style={{
                  marginTop: 6,
                  padding: 12,
                  borderRadius: 10,
                  backgroundColor: colors.background,
                  borderWidth: 1,
                  borderColor: colors.border,
                  flexDirection: "row",
                  flexWrap: "wrap",
                }}
              >
                {modal.codes.map((c) => (
                  <Text
                    key={c}
                    selectable
                    style={{
                      width: "50%",
                      paddingVertical: 4,
                      color: colors.foreground,
                      fontFamily: Platform.select({
                        ios: "Menlo",
                        android: "monospace",
                        default: "monospace",
                      }),
                      fontSize: 14,
                      letterSpacing: 1,
                    }}
                  >
                    {c}
                  </Text>
                ))}
              </View>
              <TouchableOpacity
                onPress={copyCodes}
                style={[
                  modalCardStyles.btn,
                  {
                    backgroundColor: colors.muted,
                    alignSelf: "flex-start",
                    marginTop: 4,
                  },
                ]}
                activeOpacity={0.8}
              >
                <Text style={[modalCardStyles.btnText, { color: colors.foreground }]}>
                  {copied
                    ? t("auth.twoFactor.backupCopied")
                    : t("auth.twoFactor.backupCopy")}
                </Text>
              </TouchableOpacity>
              <View style={modalCardStyles.actions}>
                <TouchableOpacity
                  onPress={() => {
                    setAcknowledged(true);
                    onClose();
                  }}
                  style={[modalCardStyles.btn, { backgroundColor: colors.primary }]}
                  activeOpacity={0.8}
                >
                  <Text style={[modalCardStyles.btnText, { color: "#fff" }]}>
                    {t("auth.twoFactor.backupAck")}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Section({
  title,
  children,
  colors,
}: {
  title: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{title.toUpperCase()}</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {children}
      </View>
    </View>
  );
}

function Row({
  colors,
  icon,
  label,
  value,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  icon: IconName;
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.itemRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Icon name={icon} size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
      </View>
      {value ? (
        <Text style={[styles.itemValue, { color: colors.mutedForeground }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      <ChevronRight size={18} color={colors.mutedForeground} style={flipIfRTL()} />
    </TouchableOpacity>
  );
}

function RowWithDesc({
  colors,
  icon,
  label,
  description,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  icon: IconName;
  label: string;
  description: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.itemRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Icon name={icon} size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
          {description}
        </Text>
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} style={flipIfRTL()} />
    </TouchableOpacity>
  );
}

function DangerRow({
  colors,
  icon,
  label,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  icon: IconName;
  label: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.itemRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.destructive + "15" }]}>
        <Icon name={icon} size={16} color={colors.destructive} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.destructive }]}>{label}</Text>
      </View>
    </TouchableOpacity>
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
      const errs: any[] = Array.isArray(e?.errors) ? e.errors : [];
      const allText = [
        ...errs.map((x) => `${x?.code ?? ""} ${x?.longMessage ?? ""} ${x?.message ?? ""} ${x?.meta?.paramName ?? ""}`),
        e?.message ?? "",
      ].join(" | ");
      const looksLikeUnsupported =
        errs.some(
          (x) =>
            x?.code === "form_param_unknown" ||
            x?.code === "form_identifier_not_allowed" ||
            x?.code === "form_param_not_allowed" ||
            x?.meta?.paramName === "username",
        ) ||
        /username.*(not a valid parameter|is not allowed|is not a valid)/i.test(allText) ||
        /not a valid parameter.*username/i.test(allText);
      if (looksLikeUnsupported) {
        setError(t("auth.username.unavailable"));
      } else {
        const firstErr = errs[0];
        setError(
          firstErr?.longMessage || firstErr?.message || e?.message || t("auth.error.generic"),
        );
      }
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
    paddingHorizontal: 12,
    paddingBottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -4,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    paddingHorizontal: 6,
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
