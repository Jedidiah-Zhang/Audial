import React, { useEffect, useRef } from "react";
import { View, StyleSheet, Animated } from "react-native";
import { useColors } from "@/hooks/useColors";

interface AudioWaveformProps {
  isActive: boolean;
  barCount?: number;
  color?: string;
}

export function AudioWaveform({ isActive, barCount = 7, color }: AudioWaveformProps) {
  const colors = useColors();
  const bars = useRef(
    Array.from({ length: barCount }, () => new Animated.Value(0.3))
  ).current;

  useEffect(() => {
    if (isActive) {
      const animations = bars.map((bar, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.timing(bar, {
              toValue: 0.2 + Math.random() * 0.8,
              duration: 300 + i * 60,
              useNativeDriver: false,
            }),
            Animated.timing(bar, {
              toValue: 0.2 + Math.random() * 0.5,
              duration: 300 + i * 60,
              useNativeDriver: false,
            }),
          ])
        )
      );
      Animated.parallel(animations).start();
      return () => animations.forEach((a) => a.stop());
    } else {
      bars.forEach((bar) =>
        Animated.spring(bar, {
          toValue: 0.3,
          useNativeDriver: false,
        }).start()
      );
    }
  }, [isActive]);

  const barColor = color ?? colors.primary;

  return (
    <View style={styles.container}>
      {bars.map((bar, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              backgroundColor: barColor,
              transform: [{ scaleY: bar }],
              opacity: isActive ? 1 : 0.4,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 48,
    gap: 4,
  },
  bar: {
    width: 4,
    height: 36,
    borderRadius: 2,
  },
});
