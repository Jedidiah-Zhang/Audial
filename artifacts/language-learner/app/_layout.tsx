import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { useFonts } from "expo-font";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { setAudioModeAsync } from "expo-audio";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl } from "@workspace/api-client-react";
import { ClerkProvider } from "@clerk/expo";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider, useApp } from "@/context/AppContext";
import { LanguageOnboarding } from "@/components/LanguageOnboarding";
import { tokenCache } from "@/utils/tokenCache";
import { applyRTL, isRTL, reloadForRTL } from "@/utils/rtl";

setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false, presentation: "modal" }} />
      <Stack.Screen name="account" options={{ headerShown: false }} />
      <Stack.Screen name="generate" options={{ headerShown: false, presentation: "modal" }} />
      <Stack.Screen
        name="practice"
        options={{ headerShown: false, animation: "fade", animationDuration: 320 }}
      />
      <Stack.Screen name="session" options={{ headerShown: false }} />
    </Stack>
  );
}

/**
 * Aligns layout direction (LTR/RTL) with the current UI language.
 * - On native: forces I18nManager and reloads the JS bundle when the
 *   direction actually changes so the new layout takes effect.
 * - On web: sets `document.dir` and remounts the app subtree via `key`
 *   so react-native-web re-evaluates `flexDirection: row` styles in the
 *   new direction without a full page reload.
 *
 * The effect waits for settings hydration (`isLoading === false`) before
 * touching `I18nManager.forceRTL` so that the persisted language wins
 * over the in-memory default — otherwise we'd briefly force LTR over a
 * persisted Arabic setting and risk a wrong "next launch" direction
 * flag on native.
 *
 * On the first hydrated apply we also reload if the native RTL flag was
 * out of sync with the persisted language (e.g. a returning user whose
 * stored language is Arabic but whose I18nManager flag was never set).
 * This converges in one reload because `applyRTL` calls `forceRTL`
 * synchronously before the reload fires, so the next launch will see
 * `changed === false` and not loop.
 */
function RTLController({ children }: { children: React.ReactNode }) {
  const { settings, isLoading } = useApp();
  const lang = settings.nativeLanguage;
  const targetRTL = isRTL(lang);

  useEffect(() => {
    if (isLoading) return;
    const { changed } = applyRTL(lang);
    if (changed) {
      // Reload on any direction change after hydration. This covers both
      // user-driven switches and the "persisted Arabic but native flag
      // out of sync" first-launch case. `reloadForRTL` is a no-op on web.
      reloadForRTL();
    }
  }, [isLoading, lang]);

  if (Platform.OS === "web") {
    return (
      <React.Fragment key={targetRTL ? "rtl" : "ltr"}>{children}</React.Fragment>
    );
  }
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: "duckOthers",
      shouldRouteThroughEarpiece: false,
      allowsRecording: false,
    }).catch(() => {
      // ignore
    });
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ClerkProvider publishableKey={clerkPublishableKey} tokenCache={tokenCache}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AppProvider>
              <GestureHandlerRootView>
                <KeyboardProvider>
                  <RTLController>
                    <RootLayoutNav />
                    <LanguageOnboarding />
                  </RTLController>
                </KeyboardProvider>
              </GestureHandlerRootView>
            </AppProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
