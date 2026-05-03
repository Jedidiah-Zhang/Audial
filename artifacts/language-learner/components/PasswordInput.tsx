import React, { forwardRef, useState } from "react";
import { View, TextInput, TouchableOpacity, StyleSheet, Platform, TextInputProps } from "react-native";
import { Eye, EyeOff } from "lucide-react-native";
import { useColors } from "@/hooks/useColors";

type Props = Omit<TextInputProps, "secureTextEntry">;

export const PasswordInput = forwardRef<TextInput, Props>(function PasswordInput(props, ref) {
  const colors = useColors();
  const [visible, setVisible] = useState(false);
  const { style, ...rest } = props;

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <TextInput
        {...rest}
        ref={ref}
        style={[styles.input, { color: colors.foreground }, style]}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity
        onPress={() => setVisible((v) => !v)}
        hitSlop={10}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityLabel={visible ? "Hide password" : "Show password"}
      >
        {visible ? (
          <EyeOff size={18} color={colors.mutedForeground} />
        ) : (
          <Eye size={18} color={colors.mutedForeground} />
        )}
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingRight: 10,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 14 : 11,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  toggle: {
    padding: 6,
  },
});
