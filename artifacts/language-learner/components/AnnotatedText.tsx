import React from "react";
import { View, Text, StyleSheet, type TextStyle } from "react-native";
import { useColors } from "@/hooks/useColors";

export type AnnotationStatus = "ok" | "wrong" | "missed" | "extra";

export interface Annotation {
  word: string;
  status: AnnotationStatus;
  correct?: string;
}

interface AnnotatedTextProps {
  title: string;
  annotations: Annotation[] | null | undefined;
  /** Fallback plain text shown if annotations are missing or empty. */
  fallbackText?: string;
  /** Text to show if both annotations and fallbackText are absent. */
  emptyText?: string;
}

const CJK_RE =
  /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/;
const TRAILING_NO_LEADING_SPACE_RE = /^[.,;:!?)\]}'"”’、，。！？；：）】｝》…·»]/;
const PREV_NO_TRAILING_SPACE_RE = /[(\[{（【｛《"'“‘«]$/;

function shouldPrependSpace(prev: string | null, cur: string): boolean {
  if (!prev || !cur) return false;
  if (TRAILING_NO_LEADING_SPACE_RE.test(cur)) return false;
  if (PREV_NO_TRAILING_SPACE_RE.test(prev)) return false;
  const prevLast = prev.charAt(prev.length - 1);
  const curFirst = cur.charAt(0);
  if (CJK_RE.test(prevLast) || CJK_RE.test(curFirst)) return false;
  // Already-spaced tokens: don't double up.
  if (/\s$/.test(prev) || /^\s/.test(cur)) return false;
  return true;
}

export function AnnotatedText({
  title,
  annotations,
  fallbackText,
  emptyText,
}: AnnotatedTextProps) {
  const colors = useColors();

  const items =
    annotations && annotations.length > 0
      ? annotations
      : fallbackText
      ? [{ word: fallbackText, status: "ok" as AnnotationStatus }]
      : null;

  if (!items) {
    if (!emptyText) return null;
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.mutedForeground }]}>{title}</Text>
        <Text style={[styles.body, { color: colors.mutedForeground, fontStyle: "italic" }]}>
          {emptyText}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.mutedForeground }]}>{title}</Text>
      <Text style={[styles.body, { color: colors.foreground }]}>
        {items.map((a, i) => {
          const prev = i > 0 ? items[i - 1].word : null;
          const space = shouldPrependSpace(prev, a.word) ? " " : "";

          let style: TextStyle | null = null;
          switch (a.status) {
            case "wrong":
              style = {
                color: colors.destructive,
                backgroundColor: colors.destructive + "22",
                textDecorationLine: "underline",
                textDecorationColor: colors.destructive,
              };
              break;
            case "missed":
              style = {
                color: colors.destructive,
                backgroundColor: colors.destructive + "11",
                textDecorationLine: "line-through",
                textDecorationColor: colors.destructive,
              };
              break;
            case "extra":
              style = {
                color: colors.mutedForeground,
                textDecorationLine: "line-through",
                textDecorationColor: colors.mutedForeground,
              };
              break;
            default:
              style = null;
          }

          return (
            <Text key={i}>
              {space}
              <Text style={style ?? undefined}>{a.word}</Text>
              {a.correct && a.status === "wrong" ? (
                <Text style={{ color: colors.success, fontStyle: "italic" }}>
                  {" "}
                  ({a.correct})
                </Text>
              ) : null}
            </Text>
          );
        })}
      </Text>
    </View>
  );
}

interface AnnotatedLegendProps {
  show: { wrong?: boolean; missed?: boolean; extra?: boolean };
  labels: {
    wrong: string;
    missed: string;
    extra: string;
  };
}

export function AnnotatedLegend({ show, labels }: AnnotatedLegendProps) {
  const colors = useColors();
  const items: { key: string; color: string; bg?: string; deco?: "underline" | "line-through"; label: string }[] = [];
  if (show.wrong) {
    items.push({
      key: "wrong",
      color: colors.destructive,
      bg: colors.destructive + "22",
      deco: "underline",
      label: labels.wrong,
    });
  }
  if (show.missed) {
    items.push({
      key: "missed",
      color: colors.destructive,
      bg: colors.destructive + "11",
      deco: "line-through",
      label: labels.missed,
    });
  }
  if (show.extra) {
    items.push({
      key: "extra",
      color: colors.mutedForeground,
      deco: "line-through",
      label: labels.extra,
    });
  }
  if (items.length === 0) return null;
  return (
    <View style={styles.legend}>
      {items.map((it) => (
        <View key={it.key} style={styles.legendItem}>
          <Text
            style={[
              styles.legendSwatch,
              {
                color: it.color,
                backgroundColor: it.bg ?? "transparent",
                textDecorationLine: it.deco ?? "none",
                textDecorationColor: it.color,
              },
            ]}
          >
            Aa
          </Text>
          <Text style={[styles.legendLabel, { color: colors.mutedForeground }]}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  title: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  body: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 26,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    paddingHorizontal: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendSwatch: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  legendLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
});
