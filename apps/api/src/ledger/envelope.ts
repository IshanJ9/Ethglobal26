// Envelope encryption for crypto-shredding: one random 32-byte DEK per record, AES-256-GCM.
// The DEK is wrapped under DATA_KEY. Shred = delete wrapped DEK + ciphertexts; commitments remain.
// Encoding: base64( iv(12) || tag(16) || ciphertext ).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function seal(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function open(key: Buffer, sealed: string): Buffer {
  const b = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

export class Envelope {
  private readonly kek: Buffer;
  constructor(dataKeyHex: string) {
    this.kek = Buffer.from(dataKeyHex.slice(2), "hex");
    if (this.kek.length !== 32) throw new Error("DATA_KEY must be 32 bytes");
  }

  /** New record key. Returns the raw DEK (keep in memory only) and its wrapped form (store). */
  newDek(): { dek: Buffer; wrapped: string } {
    const dek = randomBytes(32);
    return { dek, wrapped: seal(this.kek, dek) };
  }

  unwrap(wrapped: string): Buffer {
    return open(this.kek, wrapped);
  }

  encrypt(dek: Buffer, plain: string): string {
    return seal(dek, Buffer.from(plain, "utf8"));
  }

  decrypt(dek: Buffer, sealed: string): string {
    return open(dek, sealed).toString("utf8");
  }
}
