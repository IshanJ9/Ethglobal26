"use client";

import { useEffect, useRef, useState } from "react";
import { api, unwrap } from "@/lib/api";

type Phase = "idle" | "recording" | "transcribing";

const pickMime = () => {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
};

const toBase64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

/**
 * Dictation: records in the browser, transcribes on 0G Private Computer (whisper-large-v3, private mode).
 * The audio is sent to our API, forwarded to 0G and never stored; the text is appended to the field.
 */
export function VoiceButton({ onText, maxSeconds = 90 }: { onText: (text: string) => void; maxSeconds?: number }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const start = async () => {
    setErr(null);
    setNote(null);
    const mime = pickMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) return setErr("This browser cannot record audio.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setErr("Microphone permission was denied.");
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream, { mimeType: mime });
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearInterval(timer.current);
      setPhase("transcribing");
      try {
        const blob = new Blob(chunks, { type: mime });
        const t = await unwrap(api.POST("/v1/voice/transcriptions", { body: { audio_base64: await toBase64(blob), mime_type: mime } }));
        if (t.text) onText(t.text);
        setNote(t.text ? `Transcribed on 0G Private Computer · ${t.model} · request ${t.request_id.split(",")[0].slice(0, 12)}…` : "No speech detected.");
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPhase("idle");
      }
    };
    rec.current = r;
    r.start();
    setSecs(0);
    setPhase("recording");
    timer.current = setInterval(() => {
      setSecs((s) => {
        if (s + 1 >= maxSeconds) r.state === "recording" && r.stop();
        return s + 1;
      });
    }, 1000);
  };

  const stop = () => rec.current?.state === "recording" && rec.current.stop();

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={phase === "recording" ? stop : start}
        disabled={phase === "transcribing"}
        aria-label={phase === "recording" ? "Stop dictation" : "Dictate with your voice"}
        className={`inline-flex items-center gap-2 self-start rounded-md border px-3 py-1.5 text-sm ${
          phase === "recording" ? "border-red-500 bg-red-50 text-red-700" : "border-line bg-surface hover:bg-black/5"
        } disabled:opacity-60`}
      >
        <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${phase === "recording" ? "animate-pulse bg-red-600" : "bg-current opacity-60"}`} />
        {phase === "recording" ? `Stop · ${secs}s` : phase === "transcribing" ? "Transcribing on 0G…" : "Dictate"}
      </button>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
      {err ? <span className="text-xs text-red-700">{err}</span> : null}
    </span>
  );
}
