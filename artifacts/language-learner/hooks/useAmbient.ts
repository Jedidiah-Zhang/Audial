import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { getAmbientDataUri, getAmbientWav } from "@/utils/ambient";
import type { AmbientScene } from "@/utils/sceneDetect";

export function useAmbientPlayer() {
  const webAudioRef = useRef<HTMLAudioElement | null>(null);
  const webUrlRef = useRef<string | null>(null);
  const expoPlayerRef = useRef<any>(null);
  const playTokenRef = useRef(0);

  const stop = useCallback(() => {
    // Bump token so any in-flight play() resolves into a no-op
    playTokenRef.current += 1;
    if (webAudioRef.current) {
      try {
        webAudioRef.current.pause();
      } catch {}
      webAudioRef.current = null;
    }
    if (webUrlRef.current) {
      try {
        URL.revokeObjectURL(webUrlRef.current);
      } catch {}
      webUrlRef.current = null;
    }
    if (expoPlayerRef.current) {
      try {
        expoPlayerRef.current.pause?.();
        expoPlayerRef.current.remove?.();
      } catch {}
      expoPlayerRef.current = null;
    }
  }, []);

  const play = useCallback(async (
    sceneOrVolume: AmbientScene | number = "generic",
    maybeVolume?: number,
  ) => {
    const scene: AmbientScene =
      typeof sceneOrVolume === "string" ? sceneOrVolume : "generic";
    const volume =
      typeof sceneOrVolume === "number"
        ? sceneOrVolume
        : maybeVolume ?? 0.35;
    stop();
    const token = ++playTokenRef.current;
    try {
      if (Platform.OS === "web") {
        const buf = getAmbientWav(scene);
        const blob = new Blob([buf], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        if (token !== playTokenRef.current) {
          try { URL.revokeObjectURL(url); } catch {}
          return;
        }
        const audio = new Audio(url);
        audio.loop = true;
        audio.volume = volume;
        webAudioRef.current = audio;
        webUrlRef.current = url;
        try {
          await audio.play();
        } catch {
          /* autoplay may be blocked; ignore */
        }
        if (token !== playTokenRef.current) {
          // stop() was called while we awaited play(); tear down this audio.
          try { audio.pause(); } catch {}
          try { URL.revokeObjectURL(url); } catch {}
        }
      } else {
        const { createAudioPlayer } = await import("expo-audio");
        if (token !== playTokenRef.current) return;
        const player = createAudioPlayer({ uri: getAmbientDataUri(scene) });
        if (token !== playTokenRef.current) {
          try { player.remove?.(); } catch {}
          return;
        }
        try {
          player.loop = true;
          player.volume = volume;
        } catch {}
        expoPlayerRef.current = player;
        try {
          player.play();
        } catch {}
      }
    } catch {
      /* swallow */
    }
  }, [stop]);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  // Stable object reference so consumers can safely include it in
  // dependency arrays without re-running effects every render.
  return useMemo(() => ({ play, stop }), [play, stop]);
}
