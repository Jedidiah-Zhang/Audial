import { useCallback, useState } from "react";
import { useAuth } from "@clerk/expo";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

/**
 * Wraps the server `/language/ad/grant-reward` endpoint and returns the
 * one-shot bypass token. The caller is responsible for sending the token
 * back as the `x-reward-token` header on the next `/language/generate-text`
 * request.
 */
export interface UseGenerationQuotaResult {
  /** Server-issued bypass token state machine. */
  isRequestingToken: boolean;
  /**
   * Ask the server for a bypass token after the user has watched a
   * rewarded ad. Returns the token string on success, or null on
   * failure (network error, server-side rejection).
   */
  requestRewardToken: () => Promise<string | null>;
}

export function useGenerationQuota(): UseGenerationQuotaResult {
  const { getToken, isSignedIn } = useAuth();
  const [isRequestingToken, setIsRequestingToken] = useState(false);

  const requestRewardToken = useCallback(async (): Promise<string | null> => {
    setIsRequestingToken(true);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // The server now derives identity (and tier) from the verified
      // Clerk JWT instead of trusting client-supplied `x-user-id` /
      // `x-tier`. We attach the bearer when the user is signed in;
      // guests fall through and the server gives them a per-IP bucket.
      if (isSignedIn) {
        const token = await getToken().catch(() => null);
        if (token) headers["authorization"] = `Bearer ${token}`;
      }
      const res = await fetch(`${BASE_URL}/api/language/ad/grant-reward`, {
        method: "POST",
        headers,
        body: JSON.stringify({ placement: "generation" }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        success: boolean;
        data?: { token?: string | null };
      };
      if (!json.success) return null;
      const token = json.data?.token;
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
      return null;
    } finally {
      setIsRequestingToken(false);
    }
  }, [getToken, isSignedIn]);

  return { isRequestingToken, requestRewardToken };
}
