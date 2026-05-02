import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Rewarded video ad placements used across the Audial free tier. Each
 * value maps to a logical AdMob ad-unit id when the production AdMob
 * SDK is wired in.
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
 * - `unavailable`: an ad was not available (no fill / SDK not configured).
 *    Callers may either fall back to the paywall or silently grant the
 *    reward in dev (handled by the simulator).
 * - `error`: an exception happened in the SDK / network call.
 */
export type AdShowOutcome =
  | "rewarded"
  | "dismissed"
  | "unavailable"
  | "error";

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

/**
 * Module-level subscriber registry. The rewarded-ad simulator is
 * rendered exactly once (by `<RewardedAdSimulatorHost />` mounted at the
 * app root) and listens to this registry. Each `useRewardedAd` instance
 * registers a request callback when `show()` is invoked.
 *
 * Using a module-level singleton instead of context keeps the host
 * decoupled from the consumer tree — any screen can pop the ad without
 * having to live inside a specific provider.
 */
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
  // Fan out to every listener; the host (there is only ever one in
  // practice, but we don't enforce singletons here) handles rendering.
  for (const fn of simulatorListeners) fn(req);
}

/**
 * Whether the production AdMob SDK is configured. Production swap path:
 *
 * 1. Install `react-native-google-mobile-ads` and run `expo prebuild`.
 * 2. Set `EXPO_PUBLIC_ADMOB_APP_ID` (and per-platform IDs) in env.
 * 3. Replace the simulator branch below with the real SDK calls
 *    (`RewardedAd.createForAdRequest(...)`, `addAdEventListener(...)`,
 *    `load()`, `show()`).
 *
 * In Expo Go / development the native module is unavailable, so we
 * always fall through to the simulator. This lets the ad UX be tested
 * end-to-end without leaving the managed workflow.
 */
function isProductionAdMobConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_ADMOB_APP_ID);
}

export function useRewardedAd(placement: AdPlacement): UseRewardedAdResult {
  const [isShowing, setIsShowing] = useState(false);
  // The simulator is always "available". When the production SDK lands
  // this should reflect the real `loaded` state (and call `load()` on
  // mount + after each `show()`).
  const [isAvailable] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const show = useCallback(async (): Promise<AdShowOutcome> => {
    if (isProductionAdMobConfigured()) {
      // Production SDK path — implement when react-native-google-mobile-ads
      // is added to the project. Until then we fall through to the
      // simulator so dev/Expo Go still has a working UX.
    }
    setIsShowing(true);
    try {
      const outcome = await new Promise<AdShowOutcome>((resolve) => {
        if (simulatorListeners.size === 0) {
          // Host not mounted (shouldn't happen in normal app flow); be
          // safe and grant the reward so the user isn't stuck.
          resolve("rewarded");
          return;
        }
        dispatchSimulatorRequest({
          placement,
          resolve: (o) => resolve(o),
        });
      });
      return outcome;
    } finally {
      if (isMountedRef.current) setIsShowing(false);
    }
  }, [placement]);

  return useMemo(
    () => ({ isAvailable, isShowing, show }),
    [isAvailable, isShowing, show],
  );
}
