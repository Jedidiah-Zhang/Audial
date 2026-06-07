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
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl, setAuthTokenGetter } from "../api-client";
import { ClerkProvider, useAuth, useUser } from "@clerk/expo";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  consumePendingSignInMethod,
  notifySavedAccountsChanged,
  upsertSavedAccount,
  type SavedAccountMethod,
} from "@/utils/savedAccounts";
import { translate } from "@/utils/i18n";
import { useColors } from "@/hooks/useColors";
import { StatusBar } from "expo-status-bar";

import { AppProvider, useApp } from "@/context/AppContext";
import { RewardedAdSimulatorHost } from "@/components/RewardedAdSimulatorHost";
import { isRealAdMobActive } from "@/hooks/useRewardedAd";
import { useResolvedColorScheme } from "@/hooks/useColors";
import { tokenCache } from "@/utils/tokenCache";
import { applyRTL, isRTL, reloadForRTL } from "@/utils/rtl";

setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);

/**
 * Bridges Clerk's `getToken()` into the generated API client. This must
 * mount inside `ClerkProvider` so `useAuth()` resolves; once installed,
 * every request from the API client (and any code path
 * that imports `customFetch`) will automatically carry the user's
 * Clerk JWT in `Authorization: Bearer ...`. We intentionally don't
 * specify a template name so Clerk returns its default session token,
 * which the api-server verifies via `@clerk/backend.verifyToken`.
 */
/**
 * Watches Clerk's signed-in user and records each sign-in into the
 * device-local "saved accounts" picker so the next visit to the sign-in
 * screen can offer a one-tap re-entry. Mounting inside `ClerkProvider`
 * (where `useUser()` resolves) means we don't have to thread the
 * post-finalize user object back into each individual auth screen — any
 * code path that lands at a fresh signed-in session, including OAuth
 * redirects that re-enter the JS bundle, gets recorded automatically.
 *
 * The "method" (password / google / microsoft) is set by the auth screen
 * before it kicks off the flow via `setPendingSignInMethod()`. If we see
 * a sign-in with no pending method (e.g. cold launch into an existing
 * Clerk session, or a flow we forgot to instrument), we fall back to
 * inspecting `user.externalAccounts` and finally `user.passwordEnabled`
 * — that way the picker still records the account, just with a generic
 * method that won't get a "Continue with X" SSO highlight.
 */
function SavedAccountsRecorder() {
  const { isSignedIn, user } = useUser();
  // NOTE: this component is mounted directly under <ClerkProvider> and
  // sits *outside* <AppProvider>, so the `useT()` hook (which reads
  // `useApp()` for the current language) would throw "useApp must be
  // used within AppProvider" at runtime. Use the standalone
  // `translate()` helper with `undefined` lang — it falls back to the
  // English string table, which is the only locale this picker supports.
  const lastRecordedRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!isSignedIn || !user) {
      lastRecordedRef.current = null;
      return;
    }
    if (lastRecordedRef.current === user.id) return;
    lastRecordedRef.current = user.id;
    const pending = consumePendingSignInMethod();
    let method: SavedAccountMethod = pending ?? "password";
    if (!pending) {
      const ext = user.externalAccounts ?? [];
      const hasGoogle = ext.some((a) => a.provider === "google");
      const hasMicrosoft = ext.some((a) => a.provider === "microsoft");
      if (hasGoogle && !user.passwordEnabled) method = "google";
      else if (hasMicrosoft && !user.passwordEnabled) method = "microsoft";
      else method = "password";
    }
    const email = user.primaryEmailAddress?.emailAddress ?? null;
    const username = user.username ?? null;
    const displayName =
      user.fullName ||
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      username ||
      email ||
      translate(undefined, "auth.savedAccounts.fallbackName");
    void upsertSavedAccount({
      id: user.id,
      kind: "clerk",
      displayName,
      email,
      username,
      imageUrl: user.imageUrl ?? null,
      lastMethod: method,
    }).then(() => notifySavedAccountsChanged());
  }, [isSignedIn, user]);
  return null;
}

function ClerkApiTokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    // Intentionally NOT capturing `isSignedIn` — `getToken()` itself
    // returns null when there is no active Clerk session, so the extra
    // guard is unnecessary AND can return a stale `false` when the
    // effect hasn't re-run yet after a fast sign-in → sync sequence.
    setAuthTokenGetter(async () => {
      try {
        const token = await getToken();
        if (__DEV__ && !token) {
          console.warn("[api] getToken() returned null — API calls needing auth will fail");
        }
        return token ?? null;
      } catch (e) {
        if (__DEV__) {
          console.error("[api] getToken() threw:", e);
        }
        return null;
      }
    });
  }, [getToken]);
  return null;
}

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();
const clerkPublishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

function RootLayoutNav() {
  const colors = useColors();
  return (
    // Backstop layer behind the entire navigator. Some screens
    // (notably the practice screen, which uses
    // `presentation: "transparentModal"`) intentionally let the layer
    // beneath them show through during their custom transition. Without
    // this wrapper, anywhere the navigator briefly renders nothing —
    // for example the very last frame of the practice close animation
    // on web, or a fragment-swap gap on Android — would expose the
    // browser body / native window default background, which is white.
    // Painting `colors.background` here means any uncovered pixel
    // matches the surrounding app chrome instead of flashing white.
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack
        screenOptions={{
          headerShown: false,
          // Each non-modal screen's *native* container also gets an
          // opaque `colors.background` backing. This is the layer
          // react-native-screens paints below the React content, and
          // it's what gets exposed for the brief frame between when
          // the practice modal's Dialog Window is dismissed and when
          // the underlying screen's React tree repaints. Without
          // this, the Stack screen container falls back to its
          // default (white) on Android, which was the source of the
          // close-animation white flash.
          contentStyle: { backgroundColor: colors.background },
        }}
      >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false, presentation: "modal" }} />
      <Stack.Screen name="account" options={{ headerShown: false }} />
      <Stack.Screen name="generate" options={{ headerShown: false, presentation: "modal" }} />
      <Stack.Screen
        name="practice"
        options={{
          headerShown: false,
          // The practice screen runs its own card-expand overlay
          // animation (see app/practice.tsx). We disable the native
          // stack transition so it doesn't compete with our overlay,
          // and we present it as a transparent modal so the home
          // screen stays mounted behind it AND the modal occupies the
          // full activity window — `transparentModal` (not the
          // *contained* variant) is the one whose coordinate space
          // matches the values `measureInWindow` returns from the
          // home cards, so the overlay lands exactly on top of the
          // tapped card. The white flash that previously appeared at
          // close-end with this presentation is now neutralised by
          // the `screenOptions.contentStyle` above, which paints the
          // underlying Stack screen container with `colors.background`
          // instead of the default white — so the brief frame where
          // the Dialog Window dismisses no longer exposes white.
          animation: "none",
          presentation: "transparentModal",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      <Stack.Screen
        name="session"
        options={{
          headerShown: false,
          // Same card-expand overlay treatment as /practice — see the
          // practice screen options above for the rationale. The session
          // screen runs its own Reanimated-based expand animation
          // (see app/session.tsx), so we disable the native stack
          // transition and present transparently to keep the practice
          // screen mounted as the visible background during the open
          // and close phases.
          animation: "none",
          presentation: "transparentModal",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      </Stack>
    </View>
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
/**
 * Syncs the native StatusBar foreground (icon color) with the resolved color
 * scheme so a manual Light/Dark override doesn't leave the status bar
 * unreadable (e.g. dark icons on a dark background when the user forced dark
 * on a light OS). Lives inside `AppProvider` so it can read the user's
 * `themePreference`; falls back to the OS scheme when preference is system.
 */
function ThemedStatusBar() {
  const scheme = useResolvedColorScheme();
  // expo-status-bar's `style` controls icon color: "light" → light icons
  // (for dark backgrounds), "dark" → dark icons (for light backgrounds).
  return <StatusBar style={scheme === "dark" ? "light" : "dark"} />;
}

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
      <ClerkApiTokenBridge />
      <SavedAccountsRecorder />
      <SafeAreaProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AppProvider>
              <GestureHandlerRootView>
                <KeyboardProvider>
                  <RTLController>
                    <ThemedStatusBar />
                    <RootLayoutNav />
                    {!isRealAdMobActive() && <RewardedAdSimulatorHost />}
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
