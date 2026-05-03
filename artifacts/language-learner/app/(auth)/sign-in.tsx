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
import { User, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { GoogleIcon } from "@/components/GoogleIcon";
import { PasswordInput } from "@/components/PasswordInput";

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
  const { signIn, fetchStatus } = useSignIn();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();
  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isSignedIn) router.replace("/(tabs)");
  }, [isSignedIn]);

  const handleSubmit = async () => {
    setSubmitError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setSubmitError(error.message ?? t("auth.error.generic"));
      return;
    }
    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: () => {
          router.replace("/(tabs)");
        },
      });
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
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
          <X size={22} color={colors.foreground} />
        </TouchableOpacity>

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
        </View>
      </ScrollView>
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
