import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque prefixed ids (emp_, clm_, evd_, ...). The UI never parses them. */
export const newId = (prefix: string) => `${prefix}_${randomBytes(10).toString("hex")}`;

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export const iso = (d: Date) => d.toISOString();

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Constant-time string equality (pads to equal length so length is not leaked through early exit). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const len = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/** Random uint below 2^53 (JSON-safe, used as EIP-712 nonce). */
export function randomUint53(): number {
  const b = randomBytes(7);
  b[0] &= 0x1f; // 53 bits
  return Number(BigInt("0x" + b.toString("hex")));
}
