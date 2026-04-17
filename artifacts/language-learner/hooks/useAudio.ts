import { useState, useRef, useCallback, useEffect } from "react";
import { useAudioPlayer as useExpoAudioPlayer, useAudioRecorder as useExpoAudioRecorder, AudioModule, RecordingPresets } from "expo-audio";
import { Platform } from "react-native";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export function useAudioPlayer() {
  const [isLoading, setIsLoading] = useState(false);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const player = useExpoAudioPlayer(audioUri ? { uri: audioUri } : null);

  useEffect(() => {
    if (audioUri && player) {
      player.play();
    }
  }, [audioUri]);

  const isPlaying = player?.playing ?? false;

  const playTTS = useCallback(async (text: string, voice = "nova") => {
    try {
      setIsLoading(true);
      const response = await fetch(`${BASE_URL}/api/language/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });

      if (!response.ok) throw new Error("TTS request failed");

      const blob = await response.blob();
      const uri = URL.createObjectURL(blob);
      setAudioUri(uri);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  const stop = useCallback(() => {
    player?.pause();
  }, [player]);

  return { playTTS, stop, isPlaying, isLoading };
}

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const recorder = useExpoAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => {
    AudioModule.requestRecordingPermissionsAsync().then(({ granted }) => {
      setHasPermission(granted);
    });
  }, []);

  const startRecording = useCallback(async () => {
    if (!hasPermission) {
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      setHasPermission(granted);
      if (!granted) return false;
    }

    try {
      await recorder.record();
      setIsRecording(true);
      return true;
    } catch {
      setIsRecording(false);
      return false;
    }
  }, [hasPermission, recorder]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    if (!isRecording) return null;

    try {
      await recorder.stop();
      const uri = recorder.uri;
      setIsRecording(false);

      if (!uri) return null;

      if (Platform.OS === "web") {
        const response = await fetch(uri);
        return await response.blob();
      } else {
        const FileSystem = await import("expo-file-system");
        const base64 = await FileSystem.default.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        return new Blob([byteArray], { type: "audio/wav" });
      }
    } catch {
      setIsRecording(false);
      return null;
    }
  }, [isRecording, recorder]);

  return { startRecording, stopRecording, isRecording, hasPermission };
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const BASE = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;
  const arrayBuffer = await audioBlob.arrayBuffer();

  const response = await fetch(`${BASE}/api/language/stt`, {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/wav" },
    body: arrayBuffer,
  });

  if (!response.ok) throw new Error("Transcription failed");
  const data = await response.json() as { success: boolean; transcript: string };
  return data.transcript;
}
