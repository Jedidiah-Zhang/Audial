import React, { useState } from "react";
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
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { TextCard } from "@/components/TextCard";
import type { LearningText } from "@/types";

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { texts, removeText, updateText, getProgressForText } = useApp();

  const [renameTarget, setRenameTarget] = useState<LearningText | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const getStagesPassed = (text: LearningText) => {
    const p = getProgressForText(text.id);
    return p?.stagePassed;
  };

  const handleDelete = (id: string) => {
    Alert.alert("删除文本", "确定要删除这篇文章吗？", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => removeText(id) },
    ]);
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
          <Text style={[styles.greeting, { color: colors.mutedForeground }]}>外语学习</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>我的文章</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("/generate")}
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          activeOpacity={0.85}
        >
          <Feather name="plus" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {texts.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="book-open" size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>还没有文章</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            点击右上角添加按钮{"\n"}生成或输入学习文章
          </Text>
          <TouchableOpacity
            onPress={() => router.push("/generate")}
            style={[styles.startBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Text style={[styles.startBtnText, { color: colors.primaryForeground }]}>
              添加文章
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={texts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPad }]}
          ListHeaderComponent={
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              长按文章可重命名或删除
            </Text>
          }
          renderItem={({ item }) => (
            <TextCard
              item={item}
              onPress={() => router.push({ pathname: "/practice", params: { id: item.id } })}
              onDelete={() => handleDelete(item.id)}
              onRename={() => openRename(item)}
              stagesPassed={getStagesPassed(item)}
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
              重命名文章
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
              placeholder="新标题"
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
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmRename}
                style={[styles.modalBtn, { backgroundColor: colors.primary }]}
                activeOpacity={0.8}
              >
                <Text style={[styles.modalBtnText, { color: "#fff" }]}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
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
  hint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    marginBottom: 10,
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
