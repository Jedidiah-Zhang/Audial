import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";

/**
 * Rewarded video ad placements used across the Audial free tier. Each
 * value maps to a logical AdMob ad-unit id at runtime.
 *
 * - `generation`        : "+1 article generation" after the daily quota
 * - `analysis_unlock`   : "unlock per-sentence detailed score analysis"
 * - `dictation_replay`  : "+3 listen-again plays" on a dictation sentence
 */
export type AdPlacement =
  | "generation"
  | "analysis_unlock"
  | "dictation_replay";

/**
 * Result of a `show()` call.
 *
 * - `rewarded`: the user finished the rewarded ad and earned the reward.
 * - `dismissed`: the user closed the ad early — no reward should be
 *    granted.
 * - `unavailable`: an ad was not available (no fill / SDK not configured
 *    / SDK error). Callers may either fall back to the paywall or
 *    silently grant the reward in dev (handled by the simulator).
 */
export type AdShowOutcome = "rewarded" | "dismissed" | "unavailable";

export interface UseRewardedAdResult {
  /** Whether an ad is currently loaded & ready to show. */
  isAvailable: boolean;
  /** True while an ad is on screen (so callers can disable buttons). */
  isShowing: boolean;
  /**
   * Show the rewarded ad and resolve when the user either earns the
   * reward or dismisses the ad. Always resolves — never throws.
   */
  show: () => Promise<AdShowOutcome>;
}

// ---------------------------------------------------------------------------
// Simulator fallback registry
// ---------------------------------------------------------------------------
//
// The rewarded-ad simulator is rendered at the app root by
// `<RewardedAdSimulatorHost />` (only when the real AdMob SDK is *not*
// configured) and listens to this module-level registry. The simulator
// is what runs inside Expo Go / web previews, where the native AdMob
// module is unavailable.

type SimulatorRequest = {
  placement: AdPlacement;
  resolve: (outcome: AdShowOutcome) => void;
};

type SimulatorListener = (req: SimulatorRequest) => void;

const simulatorListeners = new Set<SimulatorListener>();

export function _registerRewardedAdSimulator(listener: SimulatorListener) {
  simulatorListeners.add(listener);
  return () => {
    simulatorListeners.delete(listener);
  };
}

function dispatchSimulatorRequest(req: SimulatorRequest) {
  for (const fn of simulatorListeners) fn(req);
}

// ---------------------------------------------------------------------------
// Real AdMob SDK
// ---------------------------------------------------------------------------
//
// Lazy-loaded via `require` so Expo Go (where the native module is
// missing) doesn't crash at import / bundle time. If the require throws
// OR if the env feature flag is not set, we fall through to the
// simulator path.
//
// To activate the real SDK in a development / production build:
//   1. The package `react-native-google-mobile-ads` must be installed
//      and the app rebuilt with `expo prebuild` / EAS Build (it cannot
//      run inside Expo Go).
//   2. Set `EXPO_PUBLIC_ADMOB_APP_ID` in env — its mere presence flips
//      this module from simulator → real ads.
//   3. Optionally override the per-placement ad unit IDs via the
//      EXPO_PUBLIC_ADMOB_REWARDED_*_(IOS|ANDROID) vars below. When
//      unset, Google's public test ad unit IDs are used so the flow
//      can be exercised in dev builds without a real AdMob account.

/**
 * `true` when the production AdMob SDK should be preferred over the
 * simulator. Driven by an env var so EAS profiles can flip the flag
 * without code changes.
 */
function isAdMobConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_ADMOB_APP_ID);
}

export function isRealAdMobActive(): boolean {
  return Platform.OS !== "web" && isAdMobConfigured();
}

// Google's public test rewarded ad unit IDs. These display real ads in
// dev builds but never earn revenue or affect production reporting —
// safe to ship as fallback defaults.
//   https://developers.google.com/admob/android/test-ads
//   https://developers.google.com/admob/ios/test-ads
const TEST_REWARDED_ID_IOS = "ca-app-pub-3940256099942544/1712485313";
const TEST_REWARDED_ID_ANDROID = "ca-app-pub-3940256099942544/5224354917";

function adUnitIdFor(placement: AdPlacement): string {
  const isIOS = Platform.OS === "ios";
  const envKey = (() => {
    switch (placement) {
      case "generation":
        return isIOS
          ? "EXPO_PUBLIC_ADMOB_REWARDED_GENERATION_ID_IOS"
          : "EXPO_PUBLIC_ADMOB_REWARDED_GENERATION_ID_ANDROID";
      case "analysis_unlock":
        return isIOS
          ? "EXPO_PUBLIC_ADMOB_REWARDED_ANALYSIS_ID_IOS"
          : "EXPO_PUBLIC_ADMOB_REWARDED_ANALYSIS_ID_ANDROID";
      case "dictation_replay":
        return isIOS
          ? "EXPO_PUBLIC_ADMOB_REWARDED_DICTATION_ID_IOS"
          : "EXPO_PUBLIC_ADMOB_REWARDED_DICTATION_ID_ANDROID";
    }
  })();
  const v = process.env[envKey];
  if (v) return v;
  return isIOS ? TEST_REWARDED_ID_IOS : TEST_REWARDED_ID_ANDROID;
}

// Cache of the dynamically-required AdMob module. `null` = unavailable
// (e.g. running in Expo Go) and we should never retry to avoid spamming
// the bundler with failing requires.
type AdMobModule = typeof import("react-native-google-mobile-ads");
let adModuleCache: AdMobModule | null | undefined = undefined;
let adInitPromise: Promise<void> | null = null;

function loadAdMobModule(): AdMobModule | null {
  if (adModuleCache !== undefined) return adModuleCache;
  if (Platform.OS === "web" || !isAdMobConfigured()) {
    adModuleCache = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    adModuleCache = require("react-native-google-mobile-ads") as AdMobModule;
  } catch {
    // Native module missing (Expo Go) — fall back to simulator.
    adModuleCache = null;
  }
  return adModuleCache;
}

async function ensureAdMobInitialized(mod: AdMobModule): Promise<void> {
  if (!adInitPromise) {
    adInitPromise = (async () => {
      try {
        await mod.default().initialize();
      } catch {
        // Initialization failed; subsequent show() calls will still try
        // to load an ad and surface their own errors / unavailable.
      }
    })();
  }
  return adInitPromise;
}

async function showRealRewardedAd(
  placement: AdPlacement,
): Promise<AdShowOutcome> {
  const mod = loadAdMobModule();
  if (!mod) return "unavailable";

  await ensureAdMobInitialized(mod);

  const { RewardedAd, RewardedAdEventType, AdEventType } = mod;

  return new Promise<AdShowOutcome>((resolve) => {
    let earned = false;
    let settled = false;
    const cleanups: Array<() => void> = [];

    const finish = (outcome: AdShowOutcome) => {
      if (settled) return;
      settled = true;
      for (const off of cleanups) {
        try {
          off();
        } catch {
          // ignore listener teardown errors
        }
      }
      resolve(outcome);
    };

    try {
      const rewarded = RewardedAd.createForAdRequest(adUnitIdFor(placement), {
        requestNonPersonalizedAdsOnly: true,
      });

      cleanups.push(
        rewarded.addAdEventListener(RewardedAdEventType.LOADED, () => {
          rewarded.show().catch(() => finish("unavailable"));
        }),
      );
      cleanups.push(
        rewarded.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
          earned = true;
        }),
      );
      cleanups.push(
        rewarded.addAdEventListener(AdEventType.CLOSED, () => {
          finish(earned ? "rewarded" : "dismissed");
        }),
      );
      cleanups.push(
        rewarded.addAdEventListener(AdEventType.ERROR, () => {
          finish("unavailable");
        }),
      );

      rewarded.load();
    } catch {
      finish("unavailable");
    }
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRewardedAd(placement: AdPlacement): UseRewardedAdResult {
  const [isShowing, setIsShowing] = useState(false);
  // The simulator is always "available". When the real SDK is active
  // we still report `true` here since `show()` will load on demand.
  const [isAvailable] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const show = useCallback(async (): Promise<AdShowOutcome> => {
    setIsShowing(true);
    try {
      // 1. Real AdMob SDK path (native + env configured). When this is
      //    active we NEVER fall through to the simulator — falling
      //    through would let a misconfigured production build silently
      //    grant rewards without showing an ad. Surface the SDK outcome
      //    (`unavailable` / `dismissed`) and let the caller decide
      //    (typically: show the paywall).
      if (isRealAdMobActive()) {
        return await showRealRewardedAd(placement);
      }

      // 2. Simulator path (Expo Go / web / dev). If the host isn't
      //    mounted, prefer to report `unavailable` over silently
      //    granting the reward — only in development do we keep the
      //    auto-grant convenience so a missing host doesn't block dev.
      return await new Promise<AdShowOutcome>((resolve) => {
        if (simulatorListeners.size === 0) {
          if (__DEV__) {
            resolve("rewarded");
          } else {
            resolve("unavailable");
          }
          return;
        }
        dispatchSimulatorRequest({
          placement,
          resolve: (o) => resolve(o),
        });
      });
    } finally {
      if (isMountedRef.current) setIsShowing(false);
    }
  }, [placement]);

  return useMemo(
    () => ({ isAvailable, isShowing, show }),
    [isAvailable, isShowing, show],
  );
}
