import React, { useCallback, useEffect, useState } from "react";
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
import { useSignIn, useSSO, useAuth } from "@clerk/expo";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Globe, User, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { GoogleIcon } from "@/components/GoogleIcon";
import { PasswordInput } from "@/components/PasswordInput";
import { LanguagePickerSheet } from "@/components/LanguagePickerSheet";
import { useApp } from "@/context/AppContext";
import { LANGUAGES } from "@/types";

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
  const { settings, updateSettings } = useApp();
  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
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

  const handleSubmit = async () => {
    setSubmitError(null);
    const trimmedEmail = emailAddress.trim();

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

      const { error } = await signIn.password({
        emailAddress: trimmedEmail,
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

      // Any other status (needs_second_factor / needs_client_trust /
      // needs_first_factor / needs_identifier / etc.) — surface the
      // status so the user (and we) can see what Clerk is asking for
      // instead of a vague "try again later".
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
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 },
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
            <User size={28} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>{t("auth.signIn.title")}</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {t("auth.signIn.subtitle")}
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.foreground }]}>{t("auth.email")}</Text>
          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
            ]}
            value={emailAddress}
            onChangeText={setEmailAddress}
            placeholder={t("auth.email.placeholder")}
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />

          <Text style={[styles.label, { color: colors.foreground, marginTop: 14 }]}>
            {t("auth.password")}
          </Text>
          <PasswordInput
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
              (!emailAddress || !password || fetchStatus === "fetching") && { opacity: 0.5 },
            ]}
            onPress={handleSubmit}
            disabled={!emailAddress || !password || fetchStatus === "fetching"}
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
            style={[styles.oauthBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
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
