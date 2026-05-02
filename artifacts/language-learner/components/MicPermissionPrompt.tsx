import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Mic, Settings as SettingsIcon } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import type { MicPermission } from "@/hooks/useAudio";

// Visual / behavioural variant the modal renders. We compute it from the
// raw permission state instead of letting callers pass it in so that "we
// can still ask the OS" vs "we have to bounce the user to settings" stays
// in one place.
type Variant = "ask" | "blocked";

function variantFor(permission: MicPermission): Variant {
  return permission === "blocked" ? "blocked" : "ask";
}

interface PromptProps {
  visible: boolean;
  permission: MicPermission;
  // Triggers the system / browser permission prompt. The parent (gate hook)
  // is responsible for closing the modal and replaying the original mic
  // action when this resolves to `"granted"`.
  onAllow: () => void | Promise<void>;
  // Native: jump to this app's entry in the OS settings. Web: no-op — the
  // modal renders a textual hint in that case rather than a button.
  onOpenSettings: () => void;
  // User dismissed without granting. The parent should drop any pending
  // "do this once granted" callback.
  onClose: () => void;
}

export function MicPermissionPrompt({
  visible,
  permission,
  onAllow,
  onOpenSettings,
  onClose,
}: PromptProps) {
  const colors = useColors();
  const t = useT();
  const [busy, setBusy] = useState(false);

  const variant = variantFor(permission);
  const isWeb = Platform.OS === "web";

  const handleAllow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAllow();
    } finally {
      setBusy(false);
    }
  }, [busy, onAllow]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Inner Pressable swallows taps so the card itself doesn't dismiss. */}
        <Pressable
          onPress={() => {}}
          style={[
            styles.card,
            { backgroundColor: colors.background, borderColor: colors.border },
          ]}
        >
          <View style={[styles.iconCircle, { backgroundColor: colors.primary + "20" }]}>
            {variant === "blocked" ? (
              <SettingsIcon size={28} color={colors.primary} />
            ) : (
              <Mic size={28} color={colors.primary} />
            )}
          </View>

          <Text style={[styles.title, { color: colors.foreground }]}>
            {t("session.permission.title")}
          </Text>

          <Text style={[styles.body, { color: colors.mutedForeground }]}>
            {variant === "blocked"
              ? isWeb
                ? t("session.permission.webHint")
                : t("session.permission.blockedBody")
              : t("session.permission.body")}
          </Text>

          {variant === "ask" ? (
            <>
              <Pressable
                onPress={handleAllow}
                disabled={busy}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  {
                    backgroundColor: colors.primary,
                    opacity: pressed || busy ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                  {t("session.permission.allow")}
                </Text>
              </Pressable>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}>
                  {t("session.permission.later")}
                </Text>
              </Pressable>
            </>
          ) : isWeb ? (
            // On web there is no API to deep-link into browser site settings,
            // so the hint text above is the actual instruction. We just give
            // the user a single dismiss button.
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [
                styles.primaryBtn,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                {t("common.confirm")}
              </Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                onPress={() => {
                  onOpenSettings();
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.primaryBtn,
                  {
                    backgroundColor: colors.primary,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                  {t("session.permission.openSettings")}
                </Text>
              </Pressable>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.mutedForeground }]}>
                  {t("common.cancel")}
                </Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Small orchestration hook that ties the prompt to a recorder. Each call
// site (ShadowSentenceFlow, session.tsx) instantiates one of these alongside
// its `useAudioRecorder()` and uses `requestAccess(onGranted)` instead of
// `startRecording()`. It:
//   1. If the mic is already granted → invokes `onGranted` synchronously and
//      returns true.
//   2. Otherwise opens the modal, remembers `onGranted`, and replays it
//      automatically the moment the user finishes the system prompt with
//      "Allow". The user only needs ONE tap on the mic — no second tap after
//      granting.
// Render the returned `modal` element somewhere in the consumer's tree.
export function useMicPermissionGate(opts: {
  permission: MicPermission;
  requestPermission: () => Promise<MicPermission>;
  openAppSettings: () => void;
}) {
  const { permission, requestPermission, openAppSettings } = opts;
  const [visible, setVisible] = useState(false);
  // Stash the action to perform once permission flips to granted, so the
  // user doesn't have to tap the mic a second time.
  const pendingRef = useRef<(() => void) | null>(null);
  // Guard the deferred replay-after-grant against the consumer unmounting
  // (e.g. user navigates away from the session screen while the system
  // permission dialog is up). Without this, the queued setTimeout would
  // call into an unmounted component and trigger a "setState on unmounted"
  // warning at best — or attempt to start recording from a torn-down hook
  // at worst.
  const mountedRef = useRef(true);
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
        replayTimerRef.current = null;
      }
    };
  }, []);

  const requestAccess = useCallback(
    (onGranted: () => void): boolean => {
      if (permission === "granted") {
        onGranted();
        return true;
      }
      pendingRef.current = onGranted;
      setVisible(true);
      return false;
    },
    [permission]
  );

  const handleAllow = useCallback(async () => {
    const next = await requestPermission();
    if (!mountedRef.current) return;
    if (next === "granted") {
      setVisible(false);
      const cb = pendingRef.current;
      pendingRef.current = null;
      // Defer to the next tick so the modal has a chance to dismiss before
      // we kick off recording (avoids any animation/interaction overlap).
      // The mountedRef check inside guards against an unmount during that
      // tiny window (user navigates away after granting).
      replayTimerRef.current = setTimeout(() => {
        replayTimerRef.current = null;
        if (!mountedRef.current) return;
        cb?.();
      }, 0);
    }
    // For "denied" / "blocked" outcomes the modal stays visible — it will
    // re-render in the "blocked" variant on the next paint because
    // `permission` updated.
  }, [requestPermission]);

  const handleClose = useCallback(() => {
    setVisible(false);
    pendingRef.current = null;
  }, []);

  const modal = (
    <MicPermissionPrompt
      visible={visible}
      permission={permission}
      onAllow={handleAllow}
      onOpenSettings={openAppSettings}
      onClose={handleClose}
    />
  );

  return { requestAccess, modal };
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 16,
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 8,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  primaryBtn: {
    width: "100%",
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  primaryBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  secondaryBtn: {
    width: "100%",
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
});
