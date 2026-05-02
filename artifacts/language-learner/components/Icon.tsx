import * as LucideIcons from "lucide-react-native";
import type { LucideProps } from "lucide-react-native";
import React from "react";

function toPascalCase(kebab: string): string {
  return kebab
    .split("-")
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
}

export type IconName = string;

type Props = LucideProps & { name: IconName };

export function Icon({ name, ...rest }: Props) {
  const lookup = LucideIcons as unknown as Record<
    string,
    React.ComponentType<LucideProps> | undefined
  >;
  const Component = lookup[toPascalCase(name)];
  if (!Component) {
    if (__DEV__) {
      console.warn(`[Icon] Unknown icon name: "${name}" (looked up as "${toPascalCase(name)}")`);
    }
    return null;
  }
  return <Component {...rest} />;
}
