import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { TokenCache } from "@clerk/expo";

const memoryCache: Record<string, string> = {};

export const tokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      if (Platform.OS === "web") {
        if (typeof window !== "undefined" && window.localStorage) {
          return window.localStorage.getItem(key);
        }
        return memoryCache[key] ?? null;
      }
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      if (Platform.OS === "web") {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem(key, value);
          return;
        }
        memoryCache[key] = value;
        return;
      }
      await SecureStore.setItemAsync(key, value);
    } catch {
      // ignore
    }
  },
  async clearToken(key: string) {
    try {
      if (Platform.OS === "web") {
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.removeItem(key);
          return;
        }
        delete memoryCache[key];
        return;
      }
      await SecureStore.deleteItemAsync(key);
    } catch {
      // ignore
    }
  },
};
