import React, { useEffect, useState } from "react";
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
import { useSignIn, useAuth } from "@clerk/expo";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyRound, X } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { PasswordInput } from "@/components/PasswordInput";

type Step = "email" | "reset";

export default function ForgotPasswordScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { signIn, fetchStatus } = useSignIn();
  const { isSignedIn } = useAuth();

  const [step, setStep] = useState<Step>("email");
  const [emailAddress, setEmailAddress] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (isSignedIn) router.replace("/(tabs)");
  }, [isSignedIn]);

  const sendCode = async () => {
    setSubmitError(null);
    setInfo(null);
    const created = await signIn.create({ identifier: emailAddress });
    if (created.error) {
      setSubmitError(created.error.message ?? t("auth.error.generic"));
      return;
    }
    const sent = await signIn.resetPasswordEmailCode.sendCode();
    if (sent.error) {
      setSubmitError(sent.error.message ?? t("auth.error.generic"));
      return;
    }
    setStep("reset");
    setInfo(t("auth.resetPassword.codeSent", { email: emailAddress }));
  };

  const resendCode = async () => {
    setSubmitError(null);
    setInfo(null);
    const sent = await signIn.resetPasswordEmailCode.sendCode();
    if (sent.error) {
      setSubmitError(sent.error.message ?? t("auth.error.generic"));
      return;
    }
    setInfo(t("auth.resetPassword.codeSent", { email: emailAddress }));
  };

  const submitReset = async () => {
    setSubmitError(null);
    const verified = await signIn.resetPasswordEmailCode.verifyCode({ code });
    if (verified.error) {
      setSubmitError(verified.error.message ?? t("auth.error.generic"));
      return;
    }
    const submitted = await signIn.resetPasswordEmailCode.submitPassword({ password });
    if (submitted.error) {
      setSubmitError(submitted.error.message ?? t("auth.error.generic"));
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

  const fetching = fetchStatus === "fetching";

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
        <TouchableOpacity onPress={() => { router.canGoBack() ? router.back() : router.replace("/(tabs)"); }} style={styles.backBtn} hitSlop={12}>
          <X size={22} color={colors.foreground} />
        </TouchableOpacity>

        <View style={styles.heroBox}>
          <View style={[styles.logo, { backgroundColor: colors.primary + "20" }]}>
            <KeyRound size={28} color={colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {t("auth.resetPassword.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {step === "email"
              ? t("auth.resetPassword.subtitle")
              : t("auth.resetPassword.subtitleReset")}
          </Text>
        </View>

        <View style={styles.form}>
          {step === "email" ? (
            <>
              <Text style={[styles.label, { color: colors.foreground }]}>{t("auth.email")}</Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                  },
                ]}
                value={emailAddress}
                onChangeText={setEmailAddress}
                placeholder={t("auth.email.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
              />

              {submitError ? (
                <Text style={[styles.fieldError, { color: colors.destructive, marginTop: 10 }]}>
                  {submitError}
                </Text>
              ) : null}

              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  { backgroundColor: colors.primary },
                  (!emailAddress || fetching) && { opacity: 0.5 },
                ]}
                onPress={sendCode}
                disabled={!emailAddress || fetching}
                activeOpacity={0.85}
              >
                {fetching ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                    {t("auth.resetPassword.sendCode")}
                  </Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              {info ? (
                <Text style={[styles.info, { color: colors.mutedForeground }]}>{info}</Text>
              ) : null}

              <Text style={[styles.label, { color: colors.foreground }]}>{t("auth.code")}</Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    color: colors.foreground,
                  },
                ]}
                value={code}
                onChangeText={setCode}
                placeholder="123456"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                autoComplete="one-time-code"
              />

              <Text style={[styles.label, { color: colors.foreground, marginTop: 14 }]}>
                {t("auth.password.new")}
              </Text>
              <PasswordInput
                value={password}
                onChangeText={setPassword}
                placeholder={t("auth.password.placeholderNew")}
                placeholderTextColor={colors.mutedForeground}
              />

              {submitError ? (
                <Text style={[styles.fieldError, { color: colors.destructive, marginTop: 10 }]}>
                  {submitError}
                </Text>
              ) : null}

              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  { backgroundColor: colors.primary },
                  (!code || !password || fetching) && { opacity: 0.5 },
                ]}
                onPress={submitReset}
                disabled={!code || !password || fetching}
                activeOpacity={0.85}
              >
                {fetching ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                    {t("auth.resetPassword.submit")}
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.resendRow}
                onPress={resendCode}
                disabled={fetching}
                hitSlop={8}
              >
                <Text
                  style={{
                    color: colors.primary,
                    fontSize: 13,
                    fontFamily: "Inter_500Medium",
                  }}
                >
                  {t("auth.verify.resend")}
                </Text>
              </TouchableOpacity>
            </>
          )}

          <View style={styles.footerRow}>
            <TouchableOpacity onPress={() => router.replace("/(auth)/sign-in")}>
              <Text
                style={{
                  color: colors.primary,
                  fontSize: 14,
                  fontFamily: "Inter_600SemiBold",
                }}
              >
                {t("auth.resetPassword.backToSignIn")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
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
  info: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 12, lineHeight: 18 },
  primaryBtn: {
    marginTop: 18,
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  resendRow: { alignSelf: "center", marginTop: 16, paddingVertical: 4 },
  footerRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 24,
  },
});
