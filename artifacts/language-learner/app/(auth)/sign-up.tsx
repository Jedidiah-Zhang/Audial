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
import { useSignUp, useSSO, useAuth } from "@clerk/expo";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";

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

export default function SignUpScreen() {
  useWarmUpBrowser();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isSignedIn } = useAuth();
  const { startSSOFlow } = useSSO();

  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (isSignedIn) router.replace("/(tabs)");
  }, [isSignedIn]);

  const handleSubmit = async () => {
    setSubmitError(null);
    const { error } = await signUp.password({ emailAddress, password });
    if (error) {
      setSubmitError(error.message ?? t("auth.error.generic"));
      return;
    }
    await signUp.verifications.sendEmailCode();
  };

  const handleVerify = async () => {
    setSubmitError(null);
    await signUp.verifications.verifyEmailCode({ code });
    if (signUp.status === "complete") {
      await signUp.finalize({
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
        const { createdSessionId, setActive } = await startSSOFlow({
          strategy,
          redirectUrl: AuthSession.makeRedirectUri(),
        });
        if (createdSessionId && setActive) {
          await setActive({
            session: createdSessionId,
            navigate: () => {
              router.replace("/(tabs)");
            },
          });
        }
      } catch (err: any) {
        setSubmitError(err?.message ?? t("auth.error.generic"));
      } finally {
        setOauthBusy(null);
      }
    },
    [startSSOFlow, t]
  );

  const isVerifyStep =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields?.includes("email_address");

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
          <Feather name="x" size={22} color={colors.foreground} />
        </TouchableOpacity>

        <View style={styles.heroBox}>
          <View style={[styles.logo, { backgroundColor: colors.primary + "20" }]}>
            <Feather name="user-plus" size={28} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {isVerifyStep ? t("auth.verify.title") : t("auth.signUp.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {isVerifyStep
              ? t("auth.verify.subtitle", { email: emailAddress })
              : t("auth.signUp.subtitle")}
          </Text>
        </View>

        {isVerifyStep ? (
          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.foreground }]}>{t("auth.code")}</Text>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
              ]}
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              maxLength={8}
            />
            {errors.fields.code && (
              <Text style={[styles.fieldError, { color: colors.destructive }]}>
                {errors.fields.code.message}
              </Text>
            )}
            {submitError ? (
              <Text style={[styles.fieldError, { color: colors.destructive, marginTop: 10 }]}>
                {submitError}
              </Text>
            ) : null}
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                { backgroundColor: colors.primary },
                (!code || fetchStatus === "fetching") && { opacity: 0.5 },
              ]}
              onPress={handleVerify}
              disabled={!code || fetchStatus === "fetching"}
              activeOpacity={0.85}
            >
              {fetchStatus === "fetching" ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                  {t("auth.verify.confirm")}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => signUp.verifications.sendEmailCode()}
              style={{ alignSelf: "center", marginTop: 14 }}
            >
              <Text style={{ color: colors.primary, fontSize: 13, fontFamily: "Inter_500Medium" }}>
                {t("auth.verify.resend")}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
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
            {errors.fields.emailAddress && (
              <Text style={[styles.fieldError, { color: colors.destructive }]}>
                {errors.fields.emailAddress.message}
              </Text>
            )}

            <Text style={[styles.label, { color: colors.foreground, marginTop: 14 }]}>
              {t("auth.password")}
            </Text>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
              ]}
              value={password}
              onChangeText={setPassword}
              placeholder={t("auth.password.placeholderNew")}
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
            />
            {errors.fields.password && (
              <Text style={[styles.fieldError, { color: colors.destructive }]}>
                {errors.fields.password.message}
              </Text>
            )}

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
                  {t("auth.signUp.create")}
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

            <TouchableOpacity
              style={[styles.oauthBtn, { borderColor: colors.border, backgroundColor: colors.card }]}
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
                {t("auth.signUp.haveAccount")}{" "}
              </Text>
              <TouchableOpacity onPress={() => router.replace("/(auth)/sign-in")}>
                <Text style={{ color: colors.primary, fontSize: 14, fontFamily: "Inter_600SemiBold" }}>
                  {t("auth.signIn.title")}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Required for Clerk's bot protection */}
            <View nativeID="clerk-captcha" />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function GoogleIcon({ size = 18 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size, fontFamily: "Inter_700Bold", color: "#4285F4" }}>G</Text>
    </View>
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
  primaryBtn: {
    marginTop: 18,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 18 },
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
  footerRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginTop: 24 },
});
