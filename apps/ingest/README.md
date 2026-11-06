# @proofwork/ingest: Telegram bot + GitHub webhook

Evidence ingestion from informal and official channels into the existing Proofwork API. It is a plain client of
the frozen spec (`/v1/dev/login`, `/v1/org/*`, `/v1/cycles`, `/v1/claims*`, `/v1/evidence/ingest`), so it needs
no spec change and the web app sees everything it files.

| Channel | Becomes | Counts toward the score |
|---|---|---|
| Telegram text (type it, or dictate it with **Wispr Flow**) | claim, AI-drafted, `drafted` | only after the co-signer signs (`verified`) |
| Telegram forward (`forward_origin`) | claim, prefixed "Forwarded message from a contact, originally sent <date>" | same |
| WhatsApp export `.txt` / `.zip` (iOS + both Android formats, multi-line) | one claim per day-chunk (max 40 msgs, 5 most recent chunks), names replaced with Person 1, 2… | same |
| Voice note / audio | not transcribed (no speech-to-text provider); the bot asks for text or Wispr Flow dictation | n/a |
| GitHub merged PR / approved review / closed `bug` issue / revert PR | `pr_merged` deliverables:1 / `review_done` code_reviews:1 / `bug_fixed` (P0-P3 label) / `pr_reverted` | immediately (system of record, verified at ingest) |

**Privacy.** Every informal message is redacted in the bot before it leaves (phones, emails, UPI IDs, card,
Aadhaar, PAN), and WhatsApp author names are pseudonymised. Regex redaction is best effort, not a guarantee. The API
then encrypts, hashes and replicates as usual. Forwarded and exported chats can be edited, so they are never treated as
verified: only the co-signer's signature makes a claim count.

**Plans.** Only KRAs whose source is `cosign`, `worklog` or `manual` accept claims. In the seed org that is the
engineering plan's `client_engagement`; the sales (commission) and marketing plans are scored only from CRM/HRIS,
so the bot tells those users their chat evidence cannot count.

**Signing.** With `AUTH_MODE=dev` the bot signs the employee's EIP-712 claim with the demo persona key (never funded,
same rule as everywhere else in the demo) and returns the co-sign magic link. With `sso` it never signs; it sends the
web link so the employee signs with their own wallet.

## Run

```bash
cp apps/ingest/.env.example apps/ingest/.env      # then set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, GITHUB_*
pnpm --filter @proofwork/api dev                  # API on :8787 (AUTH_MODE=dev)
pnpm --filter @proofwork/ingest dev               # bot (long polling) + webhook on :8788
pnpm --filter @proofwork/ingest link:code p_dev_a # t.me deep link that binds a Telegram account to Asha
pnpm --filter @proofwork/ingest github:backfill 30  # merged PRs / reviews / bug issues from GITHUB_REPO
pnpm --filter @proofwork/ingest test
```

GitHub webhook: payload URL `https://<tunnel>/webhooks/github` (smee.io or cloudflared to `localhost:8788`),
content type JSON, secret = `GITHUB_WEBHOOK_SECRET`, events: Pull requests, Pull request reviews, Issues.
Map logins with `GITHUB_LOGIN_MAP=login=emp_dev_a,...`.
