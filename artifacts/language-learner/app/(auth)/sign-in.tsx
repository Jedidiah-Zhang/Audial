import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as AuthSession from "expo-auth-session";
import { useSignIn, useSSO, useAuth, useSessionList } from "@clerk/expo";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Globe, User, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { PasswordInput } from "@/components/PasswordInput";
import { LanguagePickerSheet } from "@/components/LanguagePickerSheet";
import { useApp } from "@/context/AppContext";
import { LANGUAGES } from "@/types";
import { setPendingSignInMethod, type SavedAccount } from "@/utils/savedAccounts";
import { useSavedAccounts } from "@/hooks/useSavedAccounts";
import { SavedAccountsList } from "@/components/SavedAccountsList";

WebBrowser.maybeCompleteAuthSession();

function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

export default function SignInScreen() {
  useWarmUpBrowser();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { signIn, errors, fetchStatus } = useSignIn();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();
  // `useSessionList` exposes the typed list of sessions Clerk has cached
  // on this device along with the typed `setActive` for fast-switching.
  // Reaching into `useClerk().client.sessions` directly would force `any`
  // casts because the field is internal; this hook is the supported,
  // properly-typed access path.
  const { sessions: cachedSessions, setActive: setActiveSession } = useSessionList();
  const { settings, updateSettings, switchLocalAccount } = useApp();
  // Optional pre-fill hints from sibling screens (e.g. tapping a Clerk
  // row in the Local Accounts manage screen). Read once on mount and
  // applied as the initial identifier / suggested SSO so the user
  // lands on a primed form instead of an empty one.
  const params = useLocalSearchParams<{ identifier?: string; sso?: string }>();
  const savedAccounts = useSavedAccounts();
  const passwordInputRef = useRef<TextInput | null>(null);
  const initialIdentifier = typeof params.identifier === "string" ? params.identifier : "";
  const initialSso: "google" | "microsoft" | null =
    params.sso === "google" || params.sso === "microsoft" ? params.sso : null;
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [password, setPassword] = useState("");
  const [suggestedSso, setSuggestedSso] = useState<"google" | "microsoft" | null>(initialSso);
  // When the screen is opened with a prefilled identifier (e.g. tapped
  // from the Local Accounts manage screen), drop the keyboard straight
  // into the password field so the user can finish signing in without
  // an extra tap. Only fires once on mount.
  useEffect(() => {
    if (initialIdentifier) {
      const timer = setTimeout(() => passwordInputRef.current?.focus(), 250);
      return () => clearTimeout(timer);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [langPickerOpen, setLangPickerOpen] = useState(false);

  useEffect(() => {
    if (isSignedIn) router.replace("/(tabs)");
  }, [isSignedIn]);

  const currentLang = LANGUAGES.find((l) => l.code === settings.nativeLanguage);
  const currentLangLabel =
    currentLang?.name ?? currentLang?.english ?? settings.nativeLanguage;

  const handleSkip = async () => {
    // "Continue without an account" — mark the device as past first-launch
    // onboarding so the (tabs) gate stops redirecting back here, then drop
    // straight into the guest experience.
    await updateSettings({ onboarded: true });
    router.replace("/(tabs)");
  };

  const handleClose = () => {
    if (router.canGoBack()) { router.back(); return; }
    updateSettings({ onboarded: true }).then(() => router.replace("/(tabs)"));
  };

  /**
   * Handler for when the user taps a row in the "Continue as…" picker.
   *
   * - Local accounts switch immediately into that profile.
   * - Clerk accounts that already have a live cached session on
   *   `clerk.client.sessions` are activated directly via `setActive` —
   *   no password prompt.
   * - Otherwise we pre-fill the identifier, focus the password field,
   *   and (if the row remembers an SSO method) highlight the matching
   *   provider button as the suggested next step.
   */
  const handleSavedAccountTap = useCallback(
    async (acc: SavedAccount) => {
      setSubmitError(null);
      if (acc.kind === "local") {
        await updateSettings({ onboarded: true });
        await switchLocalAccount(acc.id);
        router.replace("/(tabs)");
        return;
      }
      // Clerk: try to fast-switch via a cached session.
      try {
        const cached = (cachedSessions ?? []).find(
          (s) => s.user?.id === acc.id && s.status === "active",
        );
        if (cached && setActiveSession) {
          await setActiveSession({
            session: cached.id,
            navigate: () => router.replace("/(tabs)"),
          });
          return;
        }
      } catch {
        // Fall through to pre-fill behaviour below.
      }
      // No live session — pre-fill and focus password. If the saved
      // method is SSO, surface that as the suggested next step.
      const prefill = acc.email || acc.username || "";
      setIdentifier(prefill);
      if (acc.lastMethod === "google" || acc.lastMethod === "microsoft") {
        setSuggestedSso(acc.lastMethod);
      } else {
        setSuggestedSso(null);
      }
      // Defer focus a tick so the prefilled identifier is committed
      // before we move the keyboard target.
      setTimeout(() => {
        passwordInputRef.current?.focus();
      }, 50);
    },
    [cachedSessions, setActiveSession, switchLocalAccount, updateSettings],
  );

  const handleSubmit = async () => {
    setSubmitError(null);
    const trimmedIdentifier = identifier.trim();

    try {
      // If the in-memory signIn resource is left over from a previous
      // attempt (e.g. abandoned or already-complete), reset it so
      // signIn.password() doesn't no-op against a stale state machine.
      const si = signIn as any;
      if (
        !!si?.id &&
        (si?.status === "complete" || si?.status === "abandoned") &&
        typeof si.reset === "function"
      ) {
        try {
          await si.reset();
        } catch {
          /* best-effort reset */
        }
      }

      setPendingSignInMethod("password");
      const { error } = await signIn.password({
        identifier: trimmedIdentifier,
        password,
      });
      if (error) {
        // Always surface whatever Clerk gave us — sign-in's UI doesn't
        // render per-field errors, so swallowing field-level errors
        // would leave the user staring at nothing.
        const errAny = error as any;
        const msg =
          errAny?.longMessage ||
          errAny?.message ||
          errAny?.errors?.[0]?.longMessage ||
          errAny?.errors?.[0]?.message ||
          errors?.fields?.identifier?.message ||
          errors?.fields?.password?.message ||
          t("auth.error.generic");
        if (__DEV__) {
          console.log("[sign-in] password() error", JSON.stringify(error, null, 2));
        }
        setSubmitError(msg);
        return;
      }

      if (signIn.status === "complete") {
        await signIn.finalize({
          navigate: () => {
            router.replace("/(tabs)");
          },
        });
        return;
      }

      // Any other status (needs_client_trust / needs_first_factor /
      // needs_identifier / etc.) — surface the status so the user
      // (and we) can see what Clerk is asking for instead of a vague
      // "try again later".
      if (__DEV__) {
        console.log("[sign-in] non-complete status", signIn.status, signIn);
      }
      setSubmitError(`Sign-in status: ${signIn.status ?? "unknown"}`);
    } catch (err: any) {
      // signIn.password() can throw on network errors / malformed state.
      // Without this catch the rejection is swallowed and the user is
      // left staring at a button that "did nothing".
      setSubmitError(err?.message ?? t("auth.error.generic"));
    }
  };

  const onOAuth = useCallback(
    async (strategy: "oauth_google" | "oauth_microsoft") => {
      try {
        setSubmitError(null);
        setOauthBusy(strategy);
        setPendingSignInMethod(strategy === "oauth_google" ? "google" : "microsoft");

        const result = await startSSOFlow({
          strategy,
          redirectUrl: AuthSession.makeRedirectUri(),
        });

        // Happy path: Clerk minted a session for an existing user.
        if (result.createdSessionId && result.setActive) {
          await result.setActive({
            session: result.createdSessionId,
            navigate: () => {
              router.replace("/(tabs)");
            },
          });
          return;
        }

        // The user closed the in-app browser before completing the
        // provider flow.
        if (
          result.authSessionResult &&
          result.authSessionResult.type !== "success"
        ) {
          return;
        }

        // startSSOFlow may have already created the user internally.
        // Activate the session from signUp if available.
        if (
          result.signUp?.status === "complete" &&
          result.signUp.createdSessionId &&
          result.setActive
        ) {
          await result.setActive({
            session: result.signUp.createdSessionId,
            navigate: () => {
              router.replace("/(tabs)");
            },
          });
          return;
        }

        // New user via OAuth: convert the verified external account.
        // Only if signUp hasn't already been completed by startSSOFlow.
        if (
          result.signUp &&
          result.signIn?.firstFactorVerification?.status === "transferable" &&
          result.signUp.status !== "complete"
        ) {
          await result.signUp.create({ transfer: true });
          if (result.signUp.createdSessionId && result.setActive) {
            await result.setActive({
              session: result.signUp.createdSessionId,
              navigate: () => {
                router.replace("/(tabs)");
              },
            });
            return;
          }
        }

        // Conversely: a Clerk account with this email exists but the
        // OAuth identity isn't linked yet — transfer to sign-in.
        if (
          result.signIn &&
          result.signUp?.verifications?.externalAccount?.status === "transferable"
        ) {
          await result.signIn.create({ transfer: true });
          if (result.signIn.createdSessionId && result.setActive) {
            await result.setActive({
              session: result.signIn.createdSessionId,
              navigate: () => {
                router.replace("/(tabs)");
              },
            });
            return;
          }
        }

        // Reached the end of every known happy path without a session.
        setSubmitError(t("auth.error.generic"));
      } catch (err: any) {
        // If Clerk threw because an existing sign-in attempt (e.g. from
        // auto-initialisation or a prior email/password attempt) conflicts
        // with the SSO transfer, reset it and retry once.
        const message: string = err?.message ?? "";
        if (
          message.toLowerCase().includes("no account to transfer") ||
          message.toLowerCase().includes("no account")
        ) {
          const si = signIn as any;
          if (si?.id && typeof si.reset === "function") {
            try { await si.reset(); } catch { /* best-effort */ }
          }
          try {
            const retry = await startSSOFlow({
              strategy,
              redirectUrl: AuthSession.makeRedirectUri(),
            });
            if (retry.createdSessionId && retry.setActive) {
              await retry.setActive({
                session: retry.createdSessionId,
                navigate: () => {
                  router.replace("/(tabs)");
                },
              });
              return;
            }
            if (
              retry.signUp &&
              retry.signIn?.firstFactorVerification?.status === "transferable" &&
              retry.signUp.status !== "complete"
            ) {
              await retry.signUp.create({ transfer: true });
              if (retry.signUp.createdSessionId && retry.setActive) {
                await retry.setActive({
                  session: retry.signUp.createdSessionId,
                  navigate: () => {
                    router.replace("/(tabs)");
                  },
                });
                return;
              }
            }
            if (
              retry.signIn &&
              retry.signUp?.verifications?.externalAccount?.status === "transferable"
            ) {
              await retry.signIn.create({ transfer: true });
              if (retry.signIn.createdSessionId && retry.setActive) {
                await retry.setActive({
                  session: retry.signIn.createdSessionId,
                  navigate: () => {
                    router.replace("/(tabs)");
                  },
                });
                return;
              }
            }
          } catch {
            // Retry also failed — fall through to show the original error.
          }
        }
        setSubmitError(message || t("auth.error.generic"));
      } finally {
        setOauthBusy(null);
      }
    },
    [startSSOFlow, t, signIn]
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.topRow}>
          <TouchableOpacity onPress={handleClose} style={styles.backBtn} hitSlop={12}>
            <X size={22} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setLangPickerOpen(true)}
            style={[styles.langChip, { borderColor: colors.border, backgroundColor: colors.card }]}
            hitSlop={6}
            activeOpacity={0.7}
          >
            <Globe size={14} color={colors.mutedForeground} />
            <Text style={[styles.langChipText, { color: colors.foreground }]} numberOfLines={1}>
              {currentLangLabel}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.heroBox}>
          <View style={[styles.logo, { backgroundColor: colors.primary + "20" }]}>
            <User size={28} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {t("auth.signIn.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {t("auth.signIn.subtitle")}
          </Text>
        </View>

        <View style={styles.form}>
          <SavedAccountsList accounts={savedAccounts} onSelect={handleSavedAccountTap} />
          <Text style={[styles.label, { color: colors.foreground }]}>{t("auth.identifier")}</Text>
          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
            ]}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder={t("auth.identifier.placeholder")}
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
          />

          <Text style={[styles.label, { color: colors.foreground, marginTop: 14 }]}>
            {t("auth.password")}
          </Text>
          <PasswordInput
            ref={passwordInputRef}
            value={password}
            onChangeText={setPassword}
            placeholder={t("auth.password.placeholder")}
            placeholderTextColor={colors.mutedForeground}
          />
          <TouchableOpacity
            style={styles.forgotRow}
            onPress={() => router.push("/(auth)/forgot-password")}
            hitSlop={8}
          >
            <Text style={{ color: colors.primary, fontSize: 13, fontFamily: "Inter_500Medium" }}>
              {t("auth.forgotPassword")}
            </Text>
          </TouchableOpacity>

          {submitError ? (
            <Text style={[styles.fieldError, { color: colors.destructive, marginTop: 10 }]}>
              {submitError}
            </Text>
          ) : null}

          <TouchableOpacity
            style={[
              styles.primaryBtn,
              { backgroundColor: colors.primary },
              (!identifier || !password || fetchStatus === "fetching") && { opacity: 0.5 },
            ]}
            onPress={handleSubmit}
            disabled={!identifier || !password || fetchStatus === "fetching"}
            activeOpacity={0.85}
          >
            {fetchStatus === "fetching" ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                {t("auth.signIn.continue")}
              </Text>
            )}
          </TouchableOpacity>

          {/* TODO: OAuth buttons temporarily disabled — Google/Microsoft SSO needs fixing */}

          <View style={styles.footerRow}>
            <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>
              {t("auth.signIn.noAccount")}{" "}
            </Text>
            <TouchableOpacity onPress={() => router.replace("/(auth)/sign-up")}>
              <Text style={{ color: colors.primary, fontSize: 14, fontFamily: "Inter_600SemiBold" }}>
                {t("auth.signUp.title")}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity onPress={handleSkip} style={styles.skipBtn} activeOpacity={0.7}>
            <Text style={{ color: colors.mutedForeground, fontSize: 14, fontFamily: "Inter_500Medium" }}>
              {t("auth.skip")}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <LanguagePickerSheet
        visible={langPickerOpen}
        selected={settings.nativeLanguage}
        onSelect={(code) => updateSettings({ nativeLanguage: code })}
        onClose={() => setLangPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}


const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 24, gap: 8 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  backBtn: { padding: 6 },
  langChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 180,
  },
  langChipText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  skipBtn: { alignSelf: "center", marginTop: 18, padding: 8 },
  heroBox: { alignItems: "center", marginTop: 16, marginBottom: 28, gap: 8 },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", textAlign: "center" },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", maxWidth: 320, lineHeight: 20 },
  form: { gap: 4 },
  label: { fontSize: 13, fontFamily: "Inter_500Medium", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 14 : 11,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  fieldError: { fontSize: 12, marginTop: 4, fontFamily: "Inter_400Regular" },
  forgotRow: { alignSelf: "flex-end", marginTop: 8, paddingVertical: 4 },
  primaryBtn: {
    marginTop: 18,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginVertical: 18,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 12, fontFamily: "Inter_500Medium", letterSpacing: 0.5 },
  oauthBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
  },
  oauthText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  footerRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 24,
  },
});
