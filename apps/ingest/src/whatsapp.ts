// WhatsApp chat export parser (.txt, or the .zip WhatsApp produces with _chat.txt inside).
// Handles the three common export line formats, multi-line messages, and system lines:
//   iOS:      [06/11/26, 14:05:33] Asha Rao: text
//   Android:  06/11/2026, 2:05 pm - Asha Rao: text
//   Android:  06/11/26, 14:05 - Asha Rao: text
// Dates are read day-first (India). Output messages are chunked by day, at most 40 per chunk.
import { unzipSync, strFromU8 } from "fflate";

export interface WaMessage {
  at: string; // ISO timestamp (local time treated as IST, +05:30)
  author: string | null; // null for system lines ("Messages are end-to-end encrypted")
  text: string;
}

export interface WaChunk {
  day: string; // YYYY-MM-DD
  messages: WaMessage[];
  text: string; // "HH:MM Author: text" lines, ready for redaction and the claim drafter
}

const IOS = /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\]\s+(.*)$/i;
const ANDROID = /^‎?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s+-\s+(.*)$/i;
const INVISIBLE = /[‎‏‪-‮﻿]/g;

function toIso(d: string, mo: string, y: string, h: string, mi: string, s: string | undefined, ampm: string | undefined): string | null {
  let year = Number(y);
  if (year < 100) year += 2000;
  let hour = Number(h);
  const ap = ampm?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  const [day, month] = [Number(d), Number(mo)];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(month)}-${p(day)}T${p(hour)}:${mi}:${s ?? "00"}+05:30`;
}

/** Parses export text into messages. Lines that do not start a message continue the previous one. */
export function parseWhatsApp(raw: string): WaMessage[] {
  const out: WaMessage[] = [];
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const m = IOS.exec(line) ?? ANDROID.exec(line);
    const at = m ? toIso(m[1], m[2], m[3], m[4], m[5], m[6], m[7]) : null;
    if (m && at) {
      const rest = m[8].replace(INVISIBLE, "");
      const colon = rest.indexOf(": ");
      out.push(colon > 0 ? { at, author: rest.slice(0, colon).trim(), text: rest.slice(colon + 2) } : { at, author: null, text: rest });
    } else if (out.length && line.trim()) {
      out[out.length - 1].text += "\n" + line.replace(INVISIBLE, "");
    }
  }
  return out.filter((m) => m.author !== null && !/^<(media omitted|attached:.*)>$/i.test(m.text.trim()) && m.text.trim() !== "This message was deleted");
}

/** Groups messages by calendar day (IST), splitting days with more than `max` messages. */
export function chunkMessages(msgs: WaMessage[], max = 40): WaChunk[] {
  const chunks: WaChunk[] = [];
  for (const m of msgs) {
    const day = m.at.slice(0, 10);
    const last = chunks[chunks.length - 1];
    if (last && last.day === day && last.messages.length < max) last.messages.push(m);
    else chunks.push({ day, messages: [m], text: "" });
  }
  for (const c of chunks) c.text = c.messages.map((m) => `${m.at.slice(11, 16)} ${m.author}: ${m.text}`).join("\n");
  return chunks;
}

/** Accepts a .txt export or a WhatsApp .zip (reads the first .txt inside). */
export function exportText(fileName: string, bytes: Uint8Array): string {
  if (/\.zip$/i.test(fileName) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const files = unzipSync(bytes, { filter: (f) => /\.txt$/i.test(f.name) && f.originalSize < 5_000_000 });
    const name = Object.keys(files).sort((a, b) => Number(!/_chat\.txt$/i.test(a)) - Number(!/_chat\.txt$/i.test(b)))[0];
    if (!name) throw new Error("zip has no .txt chat export inside");
    return strFromU8(files[name]);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Cheap check used before parsing a document someone sent the bot. */
export const looksLikeWhatsApp = (text: string) => parseWhatsApp(text.slice(0, 20_000)).length >= 2;
