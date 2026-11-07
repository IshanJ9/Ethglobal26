// Voice dictation: 0G whisper-large-v3 in private trust mode; the audio is forwarded, never stored.
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceService } from "../src/voice/voice.ts";
import { login, testApp } from "./helpers.ts";

const persona = { persona_id: "p_dev_a", role: "employee", employee_id: "emp_dev_a" } as any;
const audit = { append: vi.fn() } as any;
const clock = { now: () => new Date("2026-11-07T00:00:00Z") } as any;

describe("voice transcription", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends audio to 0G whisper in private mode and returns the transcript with request ids", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      expect(init.headers["X-0G-Provider-Trust-Mode"]).toBe("private");
      expect((init.body as FormData).get("model")).toBe("whisper-large-v3");
      return new Response(JSON.stringify({ text: " Shipped the dashboard. ", usage: { seconds: 4 } }), { status: 200, headers: { "x-request-id": "req_1", "zg-res-key": "k_1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new VoiceService({ baseUrl: "https://zg.test/v1", apiKey: "k" }, audit, clock);
    const t = await svc.transcribe(persona, { audio_base64: Buffer.from("RIFF....WAVE").toString("base64"), mime_type: "audio/webm;codecs=opus" });
    expect(t).toMatchObject({ text: "Shipped the dashboard.", provider: "0g_private_computer", request_id: "req_1", zg_res_key: "k_1", audio_seconds: 4 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://zg.test/v1/audio/transcriptions");
    expect(JSON.stringify(audit.append.mock.calls.at(-1))).not.toContain("Shipped"); // never audits the text
  });

  it("rejects non-audio and refuses when 0G is not configured", async () => {
    const svc = new VoiceService({ baseUrl: "https://zg.test/v1", apiKey: "k" }, audit, clock);
    await expect(svc.transcribe(persona, { audio_base64: "AAAA", mime_type: "text/plain" })).rejects.toMatchObject({ status: 400 });
    const off = new VoiceService(null, audit, clock);
    await expect(off.transcribe(persona, { audio_base64: "AAAA", mime_type: "audio/webm" })).rejects.toMatchObject({ status: 409 });
  });

  it("route is authenticated and contract-valid", async () => {
    const app = await testApp();
    const unauth = await app.inject({ method: "POST", url: "/v1/voice/transcriptions", payload: { audio_base64: "AAAA", mime_type: "audio/webm" } });
    expect(unauth.statusCode).toBe(401);
    const h = await login(app, "p_dev_a");
    const r = await app.inject({ method: "POST", url: "/v1/voice/transcriptions", headers: h, payload: { audio_base64: "AAAA", mime_type: "audio/webm" } });
    expect(r.statusCode).toBe(409); // mock mode: no 0G key
  });
});
