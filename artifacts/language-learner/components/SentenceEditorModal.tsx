import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ChevronsUpDown, Scissors } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useT } from "@/utils/i18n";
import { splitSentences } from "@/utils/sentences";
import { rtlTextStyle } from "@/utils/rtl";

interface SentenceEditorModalProps {
  visible: boolean;
  /** The original full text (used for "reset to default"). */
  text: string;
  /** Current sentence list. */
  sentences: string[];
  /** Locale hint for Intl.Segmenter. */
  locale?: string;
  onSave: (sentences: string[]) => void;
  onClose: () => void;
}

/**
 * Full-screen modal for reviewing and adjusting sentence boundaries
 * after article creation.
 *
 * - **Merge**: tap the divider button between two sentences.
 * - **Split**: tap a sentence card to enter split mode, then tap a gap
 *   marker between words to split at that position.
 * - **Reset**: discard edits and revert to automatic segmentation.
 */
export function SentenceEditorModal({
  visible,
  text,
  sentences: initialSentences,
  locale,
  onSave,
  onClose,
}: SentenceEditorModalProps) {
  const colors = useColors();
  const t = useT();

  const [edited, setEdited] = useState<string[]>([...initialSentences]);
  const [splitTarget, setSplitTarget] = useState<number | null>(null);

  useEffect(() => {
    if (visible) {
      setEdited([...initialSentences]);
      setSplitTarget(null);
    }
  }, [visible, initialSentences]);

  // ── actions ────────────────────────────────────────────────────────────

  const handleMerge = useCallback((index: number) => {
    setEdited((prev) => {
      if (index < 0 || index + 1 >= prev.length) return prev;
      const next = [...prev];
      next[index] = prev[index] + " " + prev[index + 1];
      next.splice(index + 1, 1);
      return next;
    });
    setSplitTarget(null);
  }, []);

  const handleSplit = useCallback((sentenceIndex: number, charOffset: number) => {
    setEdited((prev) => {
      const s = prev[sentenceIndex];
      if (!s || charOffset <= 0 || charOffset >= s.length) return prev;
      const left = s.slice(0, charOffset).trim();
      const right = s.slice(charOffset).trim();
      if (!left || !right) return prev;
      const next = [...prev];
      next.splice(sentenceIndex, 1, left, right);
      return next;
    });
    setSplitTarget(null);
  }, []);

  const handleReset = useCallback(() => {
    Alert.alert(
      t("sentenceEditor.reset"),
      t("sentenceEditor.resetConfirm"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("sentenceEditor.reset"),
          style: "destructive",
          onPress: () => {
            setEdited(splitSentences(text, locale));
            setSplitTarget(null);
          },
        },
      ]
    );
  }, [text, locale, t]);

  const handleSave = useCallback(() => {
    onSave(edited);
  }, [edited, onSave]);

  const handleCancel = useCallback(() => {
    if (JSON.stringify(edited) !== JSON.stringify(initialSentences)) {
      Alert.alert(
        t("sentenceEditor.discardTitle"),
        t("sentenceEditor.discardBody"),
        [
          { text: t("common.cancel"), style: "cancel" },
          {
            text: t("sentenceEditor.discardConfirm"),
            style: "destructive",
            onPress: onClose,
          },
        ]
      );
    } else {
      onClose();
    }
  }, [edited, initialSentences, onClose, t]);

  // ── gap helpers ────────────────────────────────────────────────────────

  /**
   * Compute character offsets of word boundaries where a sentence can be
   * split. Latin scripts: after each word. CJK: between each character.
   */
  const computeGaps = useCallback((sentence: string): number[] => {
    const gaps: number[] = [];
    const hasCJK = /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/.test(sentence);
    if (hasCJK) {
      for (let i = 1; i < sentence.length; i++) {
        gaps.push(i);
      }
    } else {
      for (let i = 0; i < sentence.length; i++) {
        if (sentence[i] === " " && i > 0 && sentence[i - 1] !== " ") {
          gaps.push(i);
        }
      }
    }
    return gaps;
  }, []);

  // ── render helpers ─────────────────────────────────────────────────────

  const renderSplitMode = (sent: string, sentenceIndex: number) => {
    const gaps = computeGaps(sent);
    const elements: React.ReactNode[] = [];
    let prev = 0;
    for (let gi = 0; gi < gaps.length; gi++) {
      const gapPos = gaps[gi];
      const segmentText = sent.slice(prev, gapPos);
      if (segmentText) {
        elements.push(
          <Text
            key={`seg-${gi}`}
            style={[styles.gapSegmentText, { color: colors.foreground }]}
          >
            {segmentText}
          </Text>
        );
      }
      // Tappable gap marker — simple bold pipe
      elements.push(
        <TouchableOpacity
          key={`gap-${gi}`}
          onPress={() => handleSplit(sentenceIndex, gapPos)}
          activeOpacity={0.4}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.gapMarker}
          accessibilityRole="button"
          accessibilityLabel={t("sentenceEditor.splitHere")}
        >
          <Text style={[styles.gapMarkerText, { color: colors.accent }]}>|</Text>
        </TouchableOpacity>
      );
      prev = gapPos;
    }
    // Tail
    const tail = sent.slice(prev);
    if (tail) {
      elements.push(
        <Text
          key="tail"
          style={[styles.gapSegmentText, { color: colors.foreground }]}
        >
          {tail}
        </Text>
      );
    }

    return (
      <View
        style={[styles.splitCard, { backgroundColor: colors.card, borderColor: colors.accent + "55" }]}
      >
        <Text style={[styles.splitLabel, { color: colors.mutedForeground }]}>
          {t("sentenceEditor.splitHint")}
        </Text>
        <View style={styles.gapRow}>{elements}</View>
      </View>
    );
  };

  const renderSentenceCard = (sent: string, i: number) => {
    const isLast = i === edited.length - 1;
    const isSplitting = splitTarget === i;

    return (
      <View key={`sent-${i}`}>
        {isSplitting ? (
          renderSplitMode(sent, i)
        ) : (
          <TouchableOpacity
            onPress={() => setSplitTarget(splitTarget === i ? null : i)}
            activeOpacity={0.8}
            style={[styles.sentCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={[styles.numBadge, { backgroundColor: colors.accent + "20" }]}>
              <Text style={[styles.numBadgeText, { color: colors.accent }]}>{i + 1}</Text>
            </View>
            <Text
              style={[styles.sentText, { color: colors.foreground }, rtlTextStyle(sent)]}
            >
              {sent}
            </Text>
            <View style={[styles.splitIcon, { backgroundColor: colors.muted }]}>
              <Scissors size={11} color={colors.mutedForeground} />
            </View>
          </TouchableOpacity>
        )}

        {/* Merge divider between sentences */}
        {!isLast && !isSplitting && (
          <View style={styles.mergeRow}>
            <View style={[styles.mergeLine, { backgroundColor: colors.border }]} />
            <TouchableOpacity
              onPress={() => handleMerge(i)}
              activeOpacity={0.7}
              style={[styles.mergeBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <ChevronsUpDown size={14} color={colors.mutedForeground} />
              <Text style={[styles.mergeBtnText, { color: colors.mutedForeground }]}>
                {t("sentenceEditor.mergeHint")}
              </Text>
            </TouchableOpacity>
            <View style={[styles.mergeLine, { backgroundColor: colors.border }]} />
          </View>
        )}
      </View>
    );
  };

  // ── main ───────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleCancel}
    >
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={handleCancel} style={styles.headerBtn} activeOpacity={0.7}>
            <Text style={[styles.headerBtnText, { color: colors.mutedForeground }]}>
              {t("common.cancel")}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            {t("sentenceEditor.title")}
          </Text>
          <View style={styles.headerBtn} />
        </View>

        <View style={[styles.hintBanner, { backgroundColor: colors.muted }]}>
          <Text style={[styles.hintBannerText, { color: colors.mutedForeground }]}>
            {t("sentenceEditor.hint")}
          </Text>
        </View>

        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator
        >
          {edited.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              {t("sentenceEditor.empty")}
            </Text>
          ) : (
            edited.map((sent, i) => renderSentenceCard(sent, i))
          )}
        </ScrollView>

        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <TouchableOpacity
            onPress={handleReset}
            style={[styles.resetBtn, { borderColor: colors.border }]}
            activeOpacity={0.7}
          >
            <Text style={[styles.resetBtnText, { color: colors.mutedForeground }]}>
              {t("sentenceEditor.reset")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSave}
            style={[styles.saveBtn, { backgroundColor: colors.accent }]}
            activeOpacity={0.85}
          >
            <Text style={styles.saveBtnText}>{t("sentenceEditor.confirm")}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 60 : 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerBtn: { paddingHorizontal: 8, paddingVertical: 6, minWidth: 60, alignItems: "center" },
  headerBtnText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  headerTitle: { fontSize: 16, fontFamily: "Inter_700Bold" },
  hintBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  hintBannerText: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  list: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 20 },

  // Sentence card
  sentCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
    paddingRight: 36,
  },
  numBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  numBadgeText: { fontSize: 12, fontFamily: "Inter_700Bold" },
  sentText: { fontSize: 16, fontFamily: "Inter_400Regular", lineHeight: 26, flex: 1 },
  splitIcon: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },

  // Merge divider
  mergeRow: { flexDirection: "row", alignItems: "center", marginVertical: 4 },
  mergeLine: { flex: 1, height: 1 },
  mergeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    marginHorizontal: 10,
  },
  mergeBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },

  // Split mode
  splitCard: {
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
    marginBottom: 4,
  },
  splitLabel: { fontSize: 11, fontFamily: "Inter_500Medium", marginBottom: 10 },
  gapRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 14 },
  gapSegmentText: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 26 },
  gapMarker: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gapMarkerText: { fontSize: 14, fontFamily: "Inter_700Bold" },

  emptyText: { fontSize: 14, fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 40 },
  footer: { padding: 16, borderTopWidth: 1, alignItems: "center", gap: 10 },
  resetBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  resetBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  saveBtn: { width: "100%", paddingVertical: 14, borderRadius: 14, alignItems: "center" },
  saveBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_700Bold" },
});
