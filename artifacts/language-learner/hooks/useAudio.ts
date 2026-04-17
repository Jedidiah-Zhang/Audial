import { useState, useRef, useCallback, useEffect } from "react";
import { Platform } from "react-native";
import { AudioModule, RecordingPresets, useAudioRecorder as useExpoAudioRecorder } from "expo-audio";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;

export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const expoPlayerRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (expoPlayerRef.current) {
        expoPlayerRef.current.remove?.();
        expoPlayerRef.current = null;
      }
    };
  }, []);

  const playTTS = useCallback(async (text: string, voice = "nova") => {
    try {
      setIsLoading(true);

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (expoPlayerRef.current) {
        expoPlayerRef.current.remove?.();
        expoPlayerRef.current = null;
      }
      setIsPlaying(false);

      const response = await fetch(`${BASE_URL}/api/language/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
      });

      if (!response.ok) throw new Error("TTS request failed");

      if (Platform.OS === "web") {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        setIsLoading(false);
        setIsPlaying(true);
        audio.onended = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(url);
        };
        await audio.play();
      } else {
        const { createAudioPlayer } = await import("expo-audio");
        const arrayBuffer = await response.arrayBuffer();
        const base64 = _arrayBufferToBase64(arrayBuffer);
        const uri = `data:audio/mpeg;base64,${base64}`;
        const player = createAudioPlayer({ uri });
        expoPlayerRef.current = player;
        setIsLoading(false);
        setIsPlaying(true);
        player.addListener("playbackStatusUpdate", (status: any) => {
          if (status.didJustFinish || !status.isLoaded) {
            setIsPlaying(false);
          }
        });
        player.play();
      }
    } catch {
      setIsPlaying(false);
      setIsLoading(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (expoPlayerRef.current) {
      expoPlayerRef.current.pause?.();
    }
    setIsPlaying(false);
  }, []);

  return { playTTS, stop, isPlaying, isLoading };
}

function _arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const recorder = useExpoAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const webMediaRef = useRef<MediaRecorder | null>(null);
  const webChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    AudioModule.requestRecordingPermissionsAsync().then(({ granted }) => {
      setHasPermission(granted);
    });
  }, []);

  const startRecording = useCallback(async (): Promise<boolean> => {
    if (!hasPermission) {
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      setHasPermission(granted);
      if (!granted) return false;
    }

    try {
      if (Platform.OS === "web") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";
        const mediaRecorder = new MediaRecorder(stream, { mimeType });
        webChunksRef.current = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) webChunksRef.current.push(e.data);
        };
        mediaRecorder.start(100);
        webMediaRef.current = mediaRecorder;
        setIsRecording(true);
        return true;
      } else {
        await recorder.record();
        setIsRecording(true);
        return true;
      }
    } catch {
      setIsRecording(false);
      return false;
    }
  }, [hasPermission, recorder]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    if (!isRecording) return null;
    setIsRecording(false);

    try {
      if (Platform.OS === "web") {
        const mediaRecorder = webMediaRef.current;
        if (!mediaRecorder) return null;

        return new Promise<Blob | null>((resolve) => {
          mediaRecorder.onstop = () => {
            const blob = new Blob(webChunksRef.current, { type: mediaRecorder.mimeType });
            mediaRecorder.stream.getTracks().forEach((t) => t.stop());
            webMediaRef.current = null;
            resolve(blob);
          };
          mediaRecorder.stop();
        });
      } else {
        await recorder.stop();
        const uri = recorder.uri;
        if (!uri) return null;

        const FileSystem = await import("expo-file-system");
        const base64 = await FileSystem.default.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const byteArray = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        return new Blob([byteArray], { type: "audio/wav" });
      }
    } catch {
      return null;
    }
  }, [isRecording, recorder]);

  return { startRecording, stopRecording, isRecording, hasPermission };
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const arrayBuffer = await audioBlob.arrayBuffer();

  const response = await fetch(`${BASE_URL}/api/language/stt`, {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: arrayBuffer,
  });

  if (!response.ok) throw new Error("Transcription failed");
  const data = await response.json() as { success: boolean; transcript: string };
  return data.transcript;
}
