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
import { Globe, ShieldCheck, User, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { GoogleIcon } from "@/components/GoogleIcon";
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
  // ---- Second-factor (MFA) state -------------------------------------
  // When Clerk returns `needs_second_factor` after the password step we
  // flip into a second screen that collects the MFA code. `mfaStrategy`
  // remembers which verify* method to call when the user submits the
  // code.
  type MfaStrategy = "totp" | "phone_code" | "backup_code";
  const [mfaStrategy, setMfaStrategy] = useState<MfaStrategy | null>(null);
  const [mfaAvailable, setMfaAvailable] = useState<MfaStrategy[]>([]);
  const [mfaCode, setMfaCode] = useState("");

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

      if (signIn.status === "needs_second_factor") {
        const factors = ((signIn as any).supportedSecondFactors ?? []) as Array<{
          strategy: string;
        }>;
        const strategies = factors
          .map((f) => f.strategy)
          .filter((s): s is MfaStrategy =>
            s === "totp" || s === "phone_code" || s === "backup_code"
          );
        // Prefer TOTP > phone_code > backup_code by default.
        const preferred: MfaStrategy =
          (strategies.includes("totp") && "totp") ||
          (strategies.includes("phone_code") && "phone_code") ||
          (strategies.includes("backup_code") && "backup_code") ||
          "totp";
        setMfaAvailable(strategies.length ? strategies : [preferred]);
        setMfaStrategy(preferred);
        setMfaCode("");
        // For SMS we have to ask Clerk to send the code before the user
        // can type it in. TOTP / backup codes are entered directly.
        if (preferred === "phone_code") {
          try {
            await (signIn as any).mfa.sendPhoneCode();
          } catch (e: any) {
            setSubmitError(e?.message ?? t("auth.error.generic"));
          }
        }
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

  const handleVerifyMfa = async () => {
    if (!mfaStrategy) return;
    setSubmitError(null);
    const code = mfaCode.trim();
    if (!code) return;
    try {
      const mfa = (signIn as any).mfa;
      let res: any;
      if (mfaStrategy === "totp") {
        res = await mfa.verifyTotp({ code });
      } else if (mfaStrategy === "phone_code") {
        res = await mfa.verifyPhoneCode({ code });
      } else {
        res = await mfa.verifyBackupCode({ code });
      }
      if (res?.error) {
        setSubmitError(
          res.error.longMessage ||
            res.error.message ||
            t("auth.error.generic"),
        );
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
      setSubmitError(`Sign-in status: ${signIn.status ?? "unknown"}`);
    } catch (err: any) {
      setSubmitError(err?.message ?? t("auth.error.generic"));
    }
  };

  const handleMfaCancel = () => {
    setMfaStrategy(null);
    setMfaAvailable([]);
    setMfaCode("");
    setSubmitError(null);
    try {
      (signIn as any)?.reset?.();
    } catch {
      /* best-effort */
    }
  };

  const handleResendPhoneCode = async () => {
    setSubmitError(null);
    try {
      await (signIn as any).mfa.sendPhoneCode();
    } catch (err: any) {
      setSubmitError(err?.message ?? t("auth.error.generic"));
    }
  };

  const onOAuth = useCallback(
    async (strategy: "oauth_google" | "oauth_microsoft") => {
      try {
        setSubmitError(null);
        setOauthBusy(strategy);
        setPendingSignInMethod(strategy === "oauth_google" ? "google" : "microsoft");
        const {
          createdSessionId,
          setActive,
          signIn: ssoSignIn,
          signUp: ssoSignUp,
          authSessionResult,
        } = await startSSOFlow({
          strategy,
          redirectUrl: AuthSession.makeRedirectUri(),
        });

        // Happy path: Clerk minted a session for an existing user.
        if (createdSessionId && setActive) {
          await setActive({
            session: createdSessionId,
            navigate: () => {
              router.replace("/(tabs)");
            },
          });
          return;
        }

        // The user closed the in-app browser before completing the
        // provider flow. Stay silent — they'll see the sign-in screen
        // again and can retry. Surfacing an error here would scold them
        // for cancelling intentionally.
        if (
          authSessionResult &&
          authSessionResult.type !== "success"
        ) {
          return;
        }

        // OAuth verification succeeded but no session yet. This happens
        // on first-ever Google sign-in: Clerk needs us to convert the
        // verified external account into a new user via the sign-up
        // transfer flow before a session can be activated.
        if (
          ssoSignUp &&
          ssoSignIn?.firstFactorVerification?.status === "transferable"
        ) {
          await ssoSignUp.create({ transfer: true });
          if (ssoSignUp.createdSessionId && setActive) {
            await setActive({
              session: ssoSignUp.createdSessionId,
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
          ssoSignIn &&
          ssoSignUp?.verifications?.externalAccount?.status === "transferable"
        ) {
          await ssoSignIn.create({ transfer: true });
          if (ssoSignIn.createdSessionId && setActive) {
            await setActive({
              session: ssoSignIn.createdSessionId,
              navigate: () => {
                router.replace("/(tabs)");
              },
            });
            return;
          }
        }

        // Reached the end of every known happy path without a session.
        // Surface something so the user isn't left staring at a silently
        // unchanged screen.
        setSubmitError(t("auth.error.generic"));
      } catch (err: any) {
        setSubmitError(err?.message ?? t("auth.error.generic"));
      } finally {
        setOauthBusy(null);
      }
    },
    [startSSOFlow, t]
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
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
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
            {mfaStrategy ? (
              <ShieldCheck size={28} color={colors.primary} />
            ) : (
              <User size={28} color={colors.primary} />
            )}
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {mfaStrategy ? t("auth.mfa.title") : t("auth.signIn.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {mfaStrategy
              ? t(
                  mfaStrategy === "phone_code"
                    ? "auth.mfa.subtitle.phone"
                    : mfaStrategy === "backup_code"
                      ? "auth.mfa.subtitle.backup"
                      : "auth.mfa.subtitle.totp",
                )
              : t("auth.signIn.subtitle")}
          </Text>
        </View>

        {mfaStrategy ? (
          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.foreground }]}>
              {t(
                mfaStrategy === "backup_code"
                  ? "auth.mfa.backupLabel"
                  : "auth.mfa.codeLabel",
              )}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
                  letterSpacing: 4,
                  textAlign: "center",
                },
              ]}
              value={mfaCode}
              onChangeText={setMfaCode}
              placeholder={mfaStrategy === "backup_code" ? "xxxx-xxxx" : "123 456"}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              keyboardType={
                mfaStrategy === "backup_code" ? "default" : "number-pad"
              }
              autoFocus
            />

            {mfaAvailable.length > 1 ? (
              <View style={styles.mfaSwitchRow}>
                {mfaAvailable
                  .filter((s) => s !== mfaStrategy)
                  .map((alt) => (
                    <TouchableOpacity
                      key={alt}
                      onPress={async () => {
                        setMfaStrategy(alt);
                        setMfaCode("");
                        setSubmitError(null);
                        if (alt === "phone_code") {
                          try {
                            await (signIn as any).mfa.sendPhoneCode();
                          } catch (e: any) {
                            setSubmitError(
                              e?.message ?? t("auth.error.generic"),
                            );
                          }
                        }
                      }}
                      hitSlop={8}
                    >
                      <Text style={{ color: colors.primary, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                        {t(
                          alt === "totp"
                            ? "auth.mfa.useTotp"
                            : alt === "phone_code"
                              ? "auth.mfa.usePhone"
                              : "auth.mfa.useBackup",
                        )}
                      </Text>
                    </TouchableOpacity>
                  ))}
              </View>
            ) : null}

            {mfaStrategy === "phone_code" ? (
              <TouchableOpacity
                onPress={handleResendPhoneCode}
                style={styles.forgotRow}
                hitSlop={8}
              >
                <Text style={{ color: colors.primary, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                  {t("auth.mfa.resend")}
                </Text>
              </TouchableOpacity>
            ) : null}

            {submitError ? (
              <Text style={[styles.fieldError, { color: colors.destructive, marginTop: 10 }]}>
                {submitError}
              </Text>
            ) : null}

            <TouchableOpacity
              style={[
                styles.primaryBtn,
                { backgroundColor: colors.primary },
                (!mfaCode.trim() || fetchStatus === "fetching") && { opacity: 0.5 },
              ]}
              onPress={handleVerifyMfa}
              disabled={!mfaCode.trim() || fetchStatus === "fetching"}
              activeOpacity={0.85}
            >
              {fetchStatus === "fetching" ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                  {t("auth.mfa.verify")}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={handleMfaCancel} style={styles.skipBtn} activeOpacity={0.7}>
              <Text style={{ color: colors.mutedForeground, fontSize: 14, fontFamily: "Inter_500Medium" }}>
                {t("auth.mfa.cancel")}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
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

          <View style={styles.dividerRow}>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
            <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>
              {t("auth.or")}
            </Text>
            <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
          </View>

          <TouchableOpacity
            style={[
              styles.oauthBtn,
              { borderColor: colors.border, backgroundColor: colors.card },
              suggestedSso === "google" && {
                borderColor: colors.primary,
                borderWidth: 2,
              },
            ]}
            onPress={() => onOAuth("oauth_google")}
            disabled={oauthBusy !== null}
            activeOpacity={0.85}
          >
            {oauthBusy === "oauth_google" ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <>
                <GoogleIcon size={18} />
                <Text style={[styles.oauthText, { color: colors.foreground }]}>
                  {t("auth.continueWith", { provider: "Google" })}
                </Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.oauthBtn,
              { borderColor: colors.border, backgroundColor: colors.card, marginTop: 10 },
              suggestedSso === "microsoft" && {
                borderColor: colors.primary,
                borderWidth: 2,
              },
            ]}
            onPress={() => onOAuth("oauth_microsoft")}
            disabled={oauthBusy !== null}
            activeOpacity={0.85}
          >
            {oauthBusy === "oauth_microsoft" ? (
              <ActivityIndicator size="small" color={colors.foreground} />
            ) : (
              <>
                <MicrosoftIcon size={18} />
                <Text style={[styles.oauthText, { color: colors.foreground }]}>
                  {t("auth.continueWith", { provider: "Microsoft" })}
                </Text>
              </>
            )}
          </TouchableOpacity>

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
        )}
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

function MicrosoftIcon({ size = 18 }: { size?: number }) {
  const s = size / 2;
  return (
    <View style={{ width: size, height: size, flexDirection: "row", flexWrap: "wrap" }}>
      <View style={{ width: s, height: s, backgroundColor: "#F25022" }} />
      <View style={{ width: s, height: s, backgroundColor: "#7FBA00" }} />
      <View style={{ width: s, height: s, backgroundColor: "#00A4EF" }} />
      <View style={{ width: s, height: s, backgroundColor: "#FFB900" }} />
    </View>
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
  mfaSwitchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    marginTop: 12,
    justifyContent: "center",
  },
});
