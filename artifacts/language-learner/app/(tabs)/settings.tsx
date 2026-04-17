import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Modal,
  FlatList,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth, useUser } from "@clerk/expo";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useT, getDifficultyLabel } from "@/utils/i18n";
import { LANGUAGES, VOICE_OPTIONS } from "@/types";
import type { Difficulty } from "@/types";
import { getFlag } from "@/utils/flags";

const SUPPORTED_UI = new Set([
  "en", "zh", "ja", "ko", "es", "fr", "de", "ru", "hu",
]);

const DIFFICULTIES: Difficulty[] = ["beginner", "elementary", "intermediate", "advanced"];

type PickerKind = "ui" | "target" | "voice" | "difficulty" | null;

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { settings, updateSettings, activeLocalAccount } = useApp();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { user } = useUser();
  const [picker, setPicker] = useState<PickerKind>(null);

  const lang = settings.nativeLanguage;
  const currentTarget = LANGUAGES.find((l) => l.code === settings.targetLanguage);
  const currentUi = LANGUAGES.find((l) => l.code === settings.nativeLanguage);
  const currentVoice = VOICE_OPTIONS.find((v) => v.id === settings.preferredVoice);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const closePicker = () => setPicker(null);

  const accountSummary = !authLoaded
    ? "…"
    : isSignedIn && user
    ? user.username || user.fullName || user.primaryEmailAddress?.emailAddress || t("auth.account.signedIn")
    : activeLocalAccount
    ? activeLocalAccount.name
    : t("auth.account.notSignedIn");

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 16 }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {t("settings.title")}
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 100, gap: 18 }}
        showsVerticalScrollIndicator={Platform.OS === "web"}
      >
        <Section title={t("settings.section.account")} colors={colors}>
          <Row
            colors={colors}
            icon="user"
            label={t("settings.section.account")}
            value={accountSummary}
            onPress={() => router.push("/account")}
          />
        </Section>
        <Section title={t("settings.section.language")} colors={colors}>
          <Row
            colors={colors}
            icon="globe"
            label={t("settings.uiLanguage")}
            value={`${getFlag(currentUi?.code ?? "en")}  ${currentUi?.name ?? "English"}`}
            onPress={() => setPicker("ui")}
          />
          <Row
            colors={colors}
            icon="book-open"
            label={t("settings.targetLanguage")}
            value={`${getFlag(currentTarget?.code ?? "en")}  ${currentTarget?.name ?? "English"}`}
            onPress={() => setPicker("target")}
          />
        </Section>

        <Section title={t("settings.section.learning")} colors={colors}>
          <Row
            colors={colors}
            icon="bar-chart-2"
            label={t("settings.difficulty")}
            value={getDifficultyLabel(settings.defaultDifficulty, lang)}
            onPress={() => setPicker("difficulty")}
          />
        </Section>

        <Section title={t("settings.section.audio")} colors={colors}>
          <Row
            colors={colors}
            icon="mic"
            label={t("settings.voice")}
            value={currentVoice?.label ?? settings.preferredVoice}
            onPress={() => setPicker("voice")}
          />
          <ToggleRow
            colors={colors}
            icon="play-circle"
            label={t("settings.autoPlay")}
            description={t("settings.autoPlay.desc")}
            value={settings.autoPlayAudio}
            onValueChange={(v) => updateSettings({ autoPlayAudio: v })}
          />
          <ToggleRow
            colors={colors}
            icon="coffee"
            label={t("settings.ambient")}
            description={t("settings.ambient.desc")}
            value={settings.ambientSound !== false}
            onValueChange={(v) => updateSettings({ ambientSound: v })}
          />
        </Section>
      </ScrollView>

      {/* Pickers */}
      <Modal visible={picker !== null} transparent animationType="fade" onRequestClose={closePicker}>
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={closePicker} />
          <View style={[styles.pickerCard, { backgroundColor: colors.card }]}>
            <View style={[styles.pickerHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.pickerTitle, { color: colors.foreground }]}>
                {picker === "ui"
                  ? t("settings.changeLanguage")
                  : picker === "target"
                  ? t("settings.changeTarget")
                  : picker === "voice"
                  ? t("settings.changeVoice")
                  : t("settings.difficulty")}
              </Text>
              <TouchableOpacity onPress={closePicker} hitSlop={10}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            {picker === "ui" && (
              <FlatList
                data={LANGUAGES.slice().sort((a, b) => a.english.localeCompare(b.english))}
                keyExtractor={(l) => l.code}
                style={{ maxHeight: 420 }}
                renderItem={({ item }) => {
                  const selected = item.code === settings.nativeLanguage;
                  const supported = SUPPORTED_UI.has(item.code);
                  return (
                    <TouchableOpacity
                      style={[styles.row, { borderBottomColor: colors.border }, selected && { backgroundColor: colors.primary + "15" }]}
                      onPress={async () => {
                        await updateSettings({ nativeLanguage: item.code });
                        closePicker();
                      }}
                    >
                      <Text style={styles.rowFlag}>{getFlag(item.code)}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {item.name}
                        </Text>
                        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                          {item.english}{!supported ? "  ·  English UI" : ""}
                        </Text>
                      </View>
                      {selected && <Feather name="check" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}

            {picker === "target" && (
              <FlatList
                data={LANGUAGES.slice().sort((a, b) => a.english.localeCompare(b.english))}
                keyExtractor={(l) => l.code}
                style={{ maxHeight: 420 }}
                renderItem={({ item }) => {
                  const selected = item.code === settings.targetLanguage;
                  return (
                    <TouchableOpacity
                      style={[styles.row, { borderBottomColor: colors.border }, selected && { backgroundColor: colors.primary + "15" }]}
                      onPress={async () => {
                        await updateSettings({ targetLanguage: item.code });
                        closePicker();
                      }}
                    >
                      <Text style={styles.rowFlag}>{getFlag(item.code)}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {item.name}
                        </Text>
                        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                          {item.english}
                        </Text>
                      </View>
                      {selected && <Feather name="check" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}

            {picker === "voice" && (
              <FlatList
                data={VOICE_OPTIONS}
                keyExtractor={(v) => v.id}
                renderItem={({ item }) => {
                  const selected = item.id === settings.preferredVoice;
                  const genderLabel = item.gender === "female" ? "♀" : item.gender === "male" ? "♂" : "·";
                  return (
                    <TouchableOpacity
                      style={[styles.row, { borderBottomColor: colors.border }, selected && { backgroundColor: colors.primary + "15" }]}
                      onPress={async () => {
                        await updateSettings({ preferredVoice: item.id });
                        closePicker();
                      }}
                    >
                      <Text style={[styles.rowFlag, { color: colors.mutedForeground }]}>{genderLabel}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {item.label}
                        </Text>
                        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                          {item.description}
                        </Text>
                      </View>
                      {selected && <Feather name="check" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}

            {picker === "difficulty" && (
              <FlatList
                data={DIFFICULTIES}
                keyExtractor={(d) => d}
                renderItem={({ item }) => {
                  const selected = item === settings.defaultDifficulty;
                  return (
                    <TouchableOpacity
                      style={[styles.row, { borderBottomColor: colors.border }, selected && { backgroundColor: colors.primary + "15" }]}
                      onPress={async () => {
                        await updateSettings({ defaultDifficulty: item });
                        closePicker();
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {getDifficultyLabel(item, lang)}
                        </Text>
                      </View>
                      {selected && <Feather name="check" size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Section({
  title,
  children,
  colors,
}: {
  title: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>{title.toUpperCase()}</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {children}
      </View>
    </View>
  );
}

function Row({
  colors,
  icon,
  label,
  value,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.itemRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Feather name={icon} size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
      </View>
      <Text style={[styles.itemValue, { color: colors.mutedForeground }]} numberOfLines={1}>
        {value}
      </Text>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
    </TouchableOpacity>
  );
}

function ToggleRow({
  colors,
  icon,
  label,
  description,
  value,
  onValueChange,
}: {
  colors: ReturnType<typeof useColors>;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Feather name={icon} size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
        {description ? (
          <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.primary }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    paddingHorizontal: 6,
  },
  sectionCard: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  itemLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  itemDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    lineHeight: 16,
  },
  itemValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    maxWidth: 160,
    textAlign: "right",
  },
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  pickerCard: {
    width: "100%",
    maxWidth: 460,
    borderRadius: 16,
    overflow: "hidden",
  },
  pickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  pickerTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowFlag: {
    fontSize: 20,
    width: 26,
    textAlign: "center",
  },
});

