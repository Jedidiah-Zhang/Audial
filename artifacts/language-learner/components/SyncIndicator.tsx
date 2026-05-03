import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Easing,
  Platform,
} from "react-native";
import { Cloud, CloudOff, Check, RefreshCw, AlertTriangle } from "lucide-react-native";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { isCloudSyncableUser } from "@/utils/cloudSync";

/**
 * Subtle pill that surfaces cloud-sync state for signed-in users.
 *
 * Hidden entirely for guests and local-only accounts (those profiles
 * never call into cloudSync, so showing a status would be misleading).
 *
 * Tapping triggers `forceSync()` — useful when the user fixed their
 * network and wants to flush the pending queue immediately instead of
 * waiting for the next mutation.
 */
export function SyncIndicator() {
  const colors = useColors();
  const t = useT();
  const { userId, syncStatus, syncPendingCount, forceSync } = useApp();

  // Spin the refresh icon while syncing. Driven by Animated.loop so it
  // stays smooth across re-renders and starts/stops cleanly with the
  // status transition.
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (syncStatus !== "syncing") {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        // RN web doesn't support useNativeDriver:true for non-transform
        // shims reliably; transforms are fine on both targets.
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [syncStatus, spin]);

  if (!isCloudSyncableUser(userId)) return null;

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const disabled = syncStatus === "syncing";

  let label: string;
  let IconCmp: typeof Cloud;
  let tint: string;
  let bg: string;

  switch (syncStatus) {
    case "syncing":
      label = t("sync.status.syncing");
      IconCmp = RefreshCw;
      tint = colors.primary;
      bg = colors.primary + "15";
      break;
    case "synced":
      label = t("sync.status.synced");
      IconCmp = Check;
      tint = colors.primary;
      bg = colors.primary + "15";
      break;
    case "offline":
      label =
        syncPendingCount > 0
          ? t("sync.status.offlinePending", { n: syncPendingCount })
          : t("sync.status.offline");
      IconCmp = CloudOff;
      tint = colors.mutedForeground;
      bg = colors.muted ?? colors.border;
      break;
    case "error":
      label = t("sync.status.error");
      IconCmp = AlertTriangle;
      tint = colors.destructive ?? "#dc2626";
      bg = (colors.destructive ?? "#dc2626") + "15";
      break;
    case "idle":
    default:
      // Idle = haven't tried yet (just signed in, mid-load). Show a
      // neutral cloud chip rather than nothing so the user still sees
      // the affordance to tap-to-sync. If there are pending items
      // already (queued from a previous session), surface that too.
      label =
        syncPendingCount > 0
          ? t("sync.status.offlinePending", { n: syncPendingCount })
          : t("sync.status.idle");
      IconCmp = Cloud;
      tint = colors.mutedForeground;
      bg = colors.muted ?? colors.border;
      break;
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      disabled={disabled}
      onPress={() => {
        void forceSync();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t("sync.tapToRetry")}
      style={[styles.pill, { backgroundColor: bg }]}
    >
      <Animated.View
        style={
          syncStatus === "syncing"
            ? { transform: [{ rotate }] }
            : undefined
        }
      >
        <IconCmp size={13} color={tint} />
      </Animated.View>
      <Text
        style={[styles.label, { color: tint }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  label: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.2,
  },
});
