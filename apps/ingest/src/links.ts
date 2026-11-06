// Telegram user <-> Proofwork persona binding.
// Link codes are stateless: hex(persona_id) + "_" + 10 hex of HMAC(LINK_SECRET, persona_id|expiry), with
// an expiry, so the bot needs no code table. `pnpm --filter @proofwork/ingest link:code p_dev_a` prints the
// t.me deep link. Bindings live in a small JSON file next to the bot (data/bindings.json, gitignored).
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const enc = (s: string) => Buffer.from(s, "utf8").toString("hex");
const dec = (s: string) => (/^(?:[0-9a-f]{2})+$/.test(s) ? Buffer.from(s, "hex").toString("utf8") : null);
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex").slice(0, 10);

/** Telegram /start payloads allow [A-Za-z0-9_-], max 64 chars. */
export function makeLinkCode(secret: string, personaId: string, expiresAtSec: number): string {
  const exp = expiresAtSec.toString(36);
  return `${enc(personaId)}_${exp}_${mac(secret, `${personaId}|${exp}`)}`;
}

export function readLinkCode(secret: string, code: string, nowSec: number): string | null {
  const parts = code.split("_");
  if (parts.length !== 3) return null;
  const [p, exp, sig] = parts;
  const personaId = dec(p);
  if (!personaId) return null;
  const want = Buffer.from(mac(secret, `${personaId}|${exp}`));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (parseInt(exp, 36) < nowSec) return null;
  return personaId;
}

export class Bindings {
  private map: Record<string, string>;
  constructor(private readonly file: string | null) {
    this.map = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  get(telegramUserId: number): string | undefined {
    return this.map[String(telegramUserId)];
  }
  set(telegramUserId: number, personaId: string) {
    this.map[String(telegramUserId)] = personaId;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.map, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }
}
