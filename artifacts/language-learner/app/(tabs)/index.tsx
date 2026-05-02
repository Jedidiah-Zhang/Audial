import React, { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  Platform,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  type View as RNView,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BookOpen, Plus } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { TextCard } from "@/components/TextCard";
import { useT } from "@/utils/i18n";
import type { LearningText } from "@/types";

type TextCardRowProps = {
  item: LearningText;
  stagesPassed: boolean[] | undefined;
  onDelete: () => void;
  onRename: () => void;
};

function TextCardRow({ item, stagesPassed, onDelete, onRename }: TextCardRowProps) {
  // TouchableOpacity forwards its ref to the underlying View, which exposes
  // the NativeMethods (including `measureInWindow`).
  const cardRef = useRef<RNView | null>(null);
  const navigatingRef = useRef(false);

  const handlePress = useCallback(() => {
    if (navigatingRef.current) return;

    const goPlain = () => {
      navigatingRef.current = true;
      router.push({ pathname: "/practice", params: { id: item.id } });
      setTimeout(() => {
        navigatingRef.current = false;
      }, 600);
    };

    const node = cardRef.current;
    if (Platform.OS === "web" || !node || typeof node.measureInWindow !== "function") {
      goPlain();
      return;
    }

    node.measureInWindow((x: number, y: number, width: number, height: number) => {
      if (!width || !height || Number.isNaN(x) || Number.isNaN(y)) {
        goPlain();
        return;
      }
      navigatingRef.current = true;
      router.push({
        pathname: "/practice",
        params: {
          id: item.id,
          oX: String(Math.round(x)),
          oY: String(Math.round(y)),
          oW: String(Math.round(width)),
          oH: String(Math.round(height)),
          oR: "16",
        },
      });
      setTimeout(() => {
        navigatingRef.current = false;
      }, 600);
    });
  }, [item.id]);

  return (
    <TextCard
      ref={cardRef}
      item={item}
      onPress={handlePress}
      onDelete={onDelete}
      onRename={onRename}
      stagesPassed={stagesPassed}
    />
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { texts, removeText, updateText, getProgressForText } = useApp();

  const [renameTarget, setRenameTarget] = useState<LearningText | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<LearningText | null>(null);

  const getStagesPassed = (text: LearningText) => {
    const p = getProgressForText(text.id);
    return p?.stagePassed;
  };

  const openDelete = (item: LearningText) => setDeleteTarget(item);
  const closeDelete = () => setDeleteTarget(null);
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await removeText(deleteTarget.id);
    closeDelete();
  };

  const openRename = (item: LearningText) => {
    setRenameTarget(item);
    setRenameValue(item.title);
  };

  const closeRename = () => {
    setRenameTarget(null);
    setRenameValue("");
  };

  const confirmRename = async () => {
    const v = renameValue.trim();
    if (!v || !renameTarget) {
      closeRename();
      return;
    }
    await updateText(renameTarget.id, { title: v });
    closeRename();
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 100 : 100;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 16 }]}>
        <View>
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>{t("home.greeting")}</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>{t("home.title")}</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/generate")}
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          activeOpacity={0.85}
        >
          <Plus size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {texts.length === 0 ? (
        <View style={styles.empty}>
          <BookOpen size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{t("home.empty.title")}</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {t("home.empty.subtitle")}
          </Text>
        </View>
      ) : (
        <FlatList
          data={texts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPad }]}
          renderItem={({ item }) => (
            <TextCardRow
              item={item}
              stagesPassed={getStagesPassed(item)}
              onDelete={() => openDelete(item)}
              onRename={() => openRename(item)}
            />
          )}
          showsVerticalScrollIndicator={false}
        />
      )}

      <Modal
        visible={!!renameTarget}
        transparent
        animationType="fade"
        onRequestClose={closeRename}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={closeRename}
          />
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {t("rename.title")}
            </Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              style={[
                styles.modalInput,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
              placeholder={t("rename.placeholder")}
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="done"
              onSubmitEditing={confirmRename}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={closeRename}
                style={[styles.modalBtn, { backgroundColor: colors.muted }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmRename}
                style={[styles.modalBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.modalBtnText, { color: "#fff" }]}>{t("common.save")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={!!deleteTarget}
        transparent
        animationType="fade"
        onRequestClose={closeDelete}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={closeDelete}
          />
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {t("home.delete.title")}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 14, lineHeight: 20 }}>
              {t("home.delete.message", { title: deleteTarget?.title ?? "" })}
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                onPress={closeDelete}
                style={[styles.modalBtn, { backgroundColor: colors.muted }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>{t("common.cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmDelete}
                style={[styles.modalBtn, { backgroundColor: colors.destructive }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.modalBtnText, { color: "#fff" }]}>{t("common.delete")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  greeting: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: "Inter_600SemiBold",
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },
  startBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  startBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
  },
  modalBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
  },
  modalBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
