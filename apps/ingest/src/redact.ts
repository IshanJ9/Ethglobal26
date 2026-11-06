// PII redaction for informal evidence (Telegram text, forwards, WhatsApp exports). Runs in the bot BEFORE any
// text leaves it, so the API, the AI drafter, the ledger hash and the 0G replica only ever see redacted text.
// Regex masking is best effort: it catches the common Indian formats, not every possible identifier.

export const REDACTION_TOKENS = ["[EMAIL]", "[UPI]", "[CARD]", "[AADHAAR]", "[PAN]", "[PHONE]"] as const;

// Order matters: cards (13-19 digits) before Aadhaar (exactly 12) so neither swallows part of the other,
// emails before UPI (both contain "@"), and the broad phone rule last.
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const AADHAAR = /(?<![\d-])\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// UPI VPA: handle@bank with no dot in the bank part, e.g. asha.rao@okaxis, 98200xxxxx@ybl.
const UPI = /\b[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}\b/g;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
// Phones: optional +CC, optional area code, then the number; only masked when it has >= 10 digits,
// so amounts like "12000" or "3 PRs" survive.
const PHONE = /(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,5}[ -]?\d{4,5}\b/g;

const digits = (s: string) => (s.match(/\d/g) ?? []).length;

/** Masks emails, UPI IDs, card numbers, Aadhaar, PAN and phone numbers. Idempotent. */
export function redact(text: string): string {
  return text
    .replace(CARD, "[CARD]")
    .replace(AADHAAR, "[AADHAAR]")
    .replace(EMAIL, "[EMAIL]")
    .replace(UPI, "[UPI]")
    .replace(PAN, "[PAN]")
    .replace(PHONE, (m) => (digits(m) >= 10 ? "[PHONE]" : m));
}
