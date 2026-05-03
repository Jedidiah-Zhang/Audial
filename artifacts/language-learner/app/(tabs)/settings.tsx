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
import { Check, ChevronRight, Sparkles, X } from "lucide-react-native";
import { flipIfRTL } from "@/utils/rtl";
import { router } from "expo-router";
import { useAuth, useUser } from "@clerk/expo";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/context/AppContext";
import { useT, getDifficultyLabel } from "@/utils/i18n";
import { LANGUAGES, VOICE_OPTIONS } from "@/types";
import type { Difficulty } from "@/types";
import { Flag } from "@/utils/flags";
import { Icon, type IconName } from "@/components/Icon";
import { PaywallModal } from "@/components/PaywallModal";
import { SyncIndicator } from "@/components/SyncIndicator";
import { isCloudSyncableUser } from "@/utils/cloudSync";

const DIFFICULTIES: Difficulty[] = ["beginner", "elementary", "intermediate", "advanced"];

type ThemePreference = "system" | "light" | "dark";
const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

type PickerKind = "ui" | "target" | "voice" | "difficulty" | "theme" | null;

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const { settings, updateSettings, activeLocalAccount, isPro, userId } = useApp();
  const { isSignedIn, isLoaded: authLoaded } = useAuth();
  const { user } = useUser();
  const [picker, setPicker] = useState<PickerKind>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);

  const lang = settings.nativeLanguage;
  const currentTarget = LANGUAGES.find((l) => l.code === settings.targetLanguage);
  const currentUi = LANGUAGES.find((l) => l.code === settings.nativeLanguage);
  const currentVoice = VOICE_OPTIONS.find((v) => v.id === settings.preferredVoice);
  const themePreference: ThemePreference = settings.themePreference ?? "system";

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
            // Only inject the pill for accounts that actually sync to
            // the cloud. Guest / local-only accounts get the standard
            // row layout with no extra slot, no empty wrapper, and no
            // forced shrink on the value text.
            inlineSlot={isCloudSyncableUser(userId) ? <SyncIndicator /> : undefined}
          />
        </Section>

        <Section title={t("settings.section.subscription")} colors={colors}>
          <SubscriptionRow
            colors={colors}
            isPro={isPro}
            label={isPro ? t("settings.subscription.subscribed") : t("settings.subscription.upgrade")}
            description={isPro ? t("settings.subscription.subscribedDesc") : t("settings.subscription.upgradeDesc")}
            badgeLabel={t("settings.subscription.badge")}
            onPress={() => setPaywallOpen(true)}
          />
        </Section>
        <Section title={t("settings.section.language")} colors={colors}>
          <Row
            colors={colors}
            icon="globe"
            label={t("settings.uiLanguage")}
            value={currentUi?.name ?? "English"}
            valuePrefix={<Flag code={currentUi?.code ?? "en-US"} size={18} />}
            onPress={() => setPicker("ui")}
          />
          <Row
            colors={colors}
            icon="book-open"
            label={t("settings.targetLanguage")}
            value={currentTarget?.name ?? "English"}
            valuePrefix={<Flag code={currentTarget?.code ?? "en-US"} size={18} />}
            onPress={() => setPicker("target")}
          />
          <Row
            colors={colors}
            icon="bar-chart-2"
            label={t("settings.difficulty")}
            value={getDifficultyLabel(settings.defaultDifficulty, lang)}
            onPress={() => setPicker("difficulty")}
          />
        </Section>

        <Section title={t("settings.section.appearance")} colors={colors}>
          <Row
            colors={colors}
            icon="moon"
            label={t("settings.theme")}
            value={t(`settings.theme.${themePreference}`)}
            onPress={() => setPicker("theme")}
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
                  : picker === "theme"
                  ? t("settings.changeTheme")
                  : t("settings.difficulty")}
              </Text>
              <TouchableOpacity onPress={closePicker} hitSlop={10}>
                <X size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            {picker === "ui" && (
              <FlatList
                data={LANGUAGES.slice().sort((a, b) => a.english.localeCompare(b.english))}
                keyExtractor={(l) => l.code}
                style={{ maxHeight: 420 }}
                renderItem={({ item }) => {
                  const selected = item.code === settings.nativeLanguage;
                  return (
                    <TouchableOpacity
                      style={[styles.row, { borderBottomColor: colors.border }, selected && { backgroundColor: colors.primary + "15" }]}
                      onPress={async () => {
                        await updateSettings({ nativeLanguage: item.code });
                        closePicker();
                      }}
                    >
                      <View style={styles.rowFlagWrap}>
                        <Flag code={item.code} size={22} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {item.name}
                        </Text>
                        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                          {item.english}
                        </Text>
                      </View>
                      {selected && <Check size={18} color={colors.primary} />}
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
                      <View style={styles.rowFlagWrap}>
                        <Flag code={item.code} size={22} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {item.name}
                        </Text>
                        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 1 }}>
                          {item.english}
                        </Text>
                      </View>
                      {selected && <Check size={18} color={colors.primary} />}
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
                        // Mark the preference as user-set so future articles
                        // stop auto-defaulting to a language-specific voice.
                        await updateSettings({ preferredVoice: item.id, preferredVoiceUserSet: true });
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
                      {selected && <Check size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}

            {picker === "theme" && (
              <FlatList
                data={THEME_PREFERENCES}
                keyExtractor={(p) => p}
                renderItem={({ item }) => {
                  const selected = item === themePreference;
                  return (
                    <TouchableOpacity
                      style={[styles.row, { borderBottomColor: colors.border }, selected && { backgroundColor: colors.primary + "15" }]}
                      onPress={async () => {
                        await updateSettings({ themePreference: item });
                        closePicker();
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: selected ? colors.primary : colors.foreground, fontSize: 15, fontFamily: selected ? "Inter_600SemiBold" : "Inter_500Medium" }}>
                          {t(`settings.theme.${item}`)}
                        </Text>
                      </View>
                      {selected && <Check size={18} color={colors.primary} />}
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
                      {selected && <Check size={18} color={colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>

      <PaywallModal visible={paywallOpen} onClose={() => setPaywallOpen(false)} />
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
  valuePrefix,
  inlineSlot,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  icon: IconName;
  label: string;
  value: string;
  /**
   * Optional element rendered immediately before the value text. Used by the
   * language rows to show a small flag image next to the language name.
   */
  valuePrefix?: React.ReactNode;
  /**
   * Optional element rendered between the value text and the chevron.
   * Used to inject custom controls (e.g. the SyncIndicator pill) into a
   * row without breaking the standard label/value/chevron layout.
   * The slot may render `null` (e.g. for guests), so callers don't need
   * to conditionally pass it.
   */
  inlineSlot?: React.ReactNode;
  onPress?: () => void;
}) {
  // When an inline slot is present we let the value text shrink instead
  // of pushing the pill or chevron off-screen on narrow widths.
  const valueCanShrink = inlineSlot != null;
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.itemRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Icon name={icon} size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
      </View>
      {valuePrefix ? (
        <View style={styles.valuePrefixWrap}>{valuePrefix}</View>
      ) : null}
      <Text
        style={[
          styles.itemValue,
          { color: colors.mutedForeground },
          valueCanShrink && { flexShrink: 1, minWidth: 0 },
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
      {inlineSlot ? <View style={styles.inlineSlotWrap}>{inlineSlot}</View> : null}
      <ChevronRight size={18} color={colors.mutedForeground} style={flipIfRTL()} />
    </TouchableOpacity>
  );
}

function SubscriptionRow({
  colors,
  isPro,
  label,
  description,
  badgeLabel,
  onPress,
}: {
  colors: ReturnType<typeof useColors>;
  isPro: boolean;
  label: string;
  description: string;
  badgeLabel: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      style={[styles.itemRow, { borderBottomColor: colors.border }]}
    >
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Sparkles size={16} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.itemLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.itemDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
          {description}
        </Text>
      </View>
      {isPro ? (
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            backgroundColor: colors.primary + "18",
          }}
        >
          <Text
            style={{
              fontSize: 11,
              fontFamily: "Inter_700Bold",
              color: colors.primary,
              letterSpacing: 0.4,
            }}
          >
            {badgeLabel}
          </Text>
        </View>
      ) : null}
      <ChevronRight size={18} color={colors.mutedForeground} style={flipIfRTL()} />
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
  icon: IconName;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={[styles.itemRow, { borderBottomColor: colors.border }]}>
      <View style={[styles.iconWrap, { backgroundColor: colors.primary + "15" }]}>
        <Icon name={icon} size={16} color={colors.primary} />
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
  inlineSlotWrap: {
    marginLeft: 8,
    flexShrink: 0,
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
  rowFlagWrap: {
    width: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  valuePrefixWrap: {
    marginRight: 6,
    alignItems: "center",
    justifyContent: "center",
  },
});

