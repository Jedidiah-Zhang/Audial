import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdPlacement =
  | "generation"
  | "analysis_unlock"
  | "dictation_hint"
  | "recitation_hint";

export type AdShowOutcome = "rewarded" | "dismissed" | "unavailable";

export interface UseRewardedAdResult {
  isAvailable: boolean;
  isShowing: boolean;
  show: () => Promise<AdShowOutcome>;
}

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

export function isRealAdMobActive(): boolean {
  return false;
}

export function useRewardedAd(placement: AdPlacement): UseRewardedAdResult {
  const [isShowing, setIsShowing] = useState(false);
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
      return await new Promise<AdShowOutcome>((resolve) => {
        if (simulatorListeners.size === 0) {
          resolve(__DEV__ ? "rewarded" : "unavailable");
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
