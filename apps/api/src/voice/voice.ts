// Voice dictation: speech-to-text on 0G Private Computer (whisper-large-v3, private trust mode).
// The audio is sent to 0G only, never stored by us; the transcript goes back to the caller, who files it as a
// normal claim draft (redacted, sealed, committed like typed text). Only the 0G request id is audited, never text.
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import { isInternal } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { Persona } from "../db/org.ts";
import { iso, type Clock } from "../util.ts";

export type VoiceTranscript = components["schemas"]["VoiceTranscript"];

export const VOICE_MODEL = "whisper-large-v3";
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MIME_RE = /^audio\/(webm|ogg|mpeg|mp4|mp3|wav|x-wav|m4a|x-m4a|aac)(;.*)?$/i;
const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", mpeg: "mp3", mp3: "mp3", mp4: "m4a", m4a: "m4a", "x-m4a": "m4a", wav: "wav", "x-wav": "wav", aac: "aac" };

export class VoiceService {
  constructor(
    private readonly zg: { baseUrl: string; apiKey: string } | null,
    private readonly audit: AuditRepo,
    private readonly clock: Clock,
  ) {}

  async transcribe(p: Persona, body: { audio_base64: string; mime_type: string; language?: string | null }): Promise<VoiceTranscript> {
    if (!isInternal(p)) throw errors.forbidden("Only employees can dictate");
    if (!this.zg) throw errors.invalidState("Voice needs 0G Private Computer (ZEROG_MODE=live and ZEROG_API_KEY)");
    const m = MIME_RE.exec(body.mime_type ?? "");
    if (!m) throw errors.validation("Unsupported audio type", { mime_type: body.mime_type });
    const bytes = Buffer.from(body.audio_base64 ?? "", "base64");
    if (!bytes.length) throw errors.validation("Empty audio");
    if (bytes.length > MAX_AUDIO_BYTES) throw errors.validation("Audio is over 2 MB (about 2 minutes)");

    const form = new FormData();
    form.append("model", VOICE_MODEL);
    if (body.language) form.append("language", body.language);
    form.append("file", new Blob([bytes], { type: body.mime_type.split(";")[0] }), `dictation.${EXT[m[1].toLowerCase()] ?? "webm"}`);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.zg.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.zg.apiKey}`, "X-0G-Provider-Trust-Mode": "private" },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw errors.invalidState(`0G speech-to-text is unreachable: ${(e as Error).message.slice(0, 120)}`);
    }
    if (!res.ok) throw errors.invalidState(`0G speech-to-text failed (HTTP ${res.status})`);
    const out = (await res.json()) as { text?: string; usage?: { seconds?: number } };
    const text = String(out.text ?? "").trim();
    const ids = res.headers.get("x-request-id");
    const transcript: VoiceTranscript = {
      text,
      provider: "0g_private_computer",
      model: VOICE_MODEL,
      request_id: ids ?? "unknown",
      zg_res_key: res.headers.get("zg-res-key"),
      audio_seconds: typeof out.usage?.seconds === "number" ? out.usage.seconds : null,
      latency_ms: Date.now() - started,
      created_at: iso(this.clock.now()),
    };
    this.audit.append(transcript.created_at, p.persona_id, "voice.transcribed", p.persona_id, { request_id: transcript.request_id, audio_seconds: transcript.audio_seconds, chars: text.length });
    return transcript;
  }
}
