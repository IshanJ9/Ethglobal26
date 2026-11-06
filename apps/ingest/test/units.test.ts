import { createHmac } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { mapGithubEvent, parseLoginMap, verifySignature } from "../src/github.ts";
import { makeLinkCode, readLinkCode } from "../src/links.ts";
import { redact } from "../src/redact.ts";
import { chunkMessages, exportText, looksLikeWhatsApp, parseWhatsApp } from "../src/whatsapp.ts";
import { pseudonymise } from "../src/core.ts";

describe("redact", () => {
  it("masks Indian PII and keeps work numbers", () => {
    const t = redact(
      "Call me on +91 98200 12345 or 022-2345 6789, mail asha.rao@acme.co.in, pay asha@okaxis, card 4111 1111 1111 1111, Aadhaar 1234 5678 9012, PAN ABCDE1234F. Closed 3 deals worth 12000 USD, 45 min call.",
    );
    expect(t).toContain("[PHONE]");
    expect(t).toContain("[EMAIL]");
    expect(t).toContain("[UPI]");
    expect(t).toContain("[CARD]");
    expect(t).toContain("[AADHAAR]");
    expect(t).toContain("[PAN]");
    for (const leak of ["98200", "asha.rao@", "okaxis", "4111", "9012", "ABCDE1234F", "2345 6789"]) expect(t).not.toContain(leak);
    expect(t).toContain("3 deals worth 12000 USD, 45 min call");
  });

  it("is idempotent and leaves dates and times alone", () => {
    const s = "Met the CFO on 06/11/2026 at 14:05 for 2 hours, 98201 23456";
    expect(redact(redact(s))).toBe(redact(s));
    expect(redact(s)).toContain("06/11/2026 at 14:05 for 2 hours");
  });
});

const IOS = `[06/11/26, 14:05:33] Asha Rao: Sent the revised SOW to Acme
[06/11/26, 14:06:10] Rohan (Acme): Got it, we sign Friday.
Also loop in finance
[07/11/26, 09:00:00] Asha Rao: ‎<attached: 00000012-PHOTO.jpg>
[07/11/26, 09:01:00] Asha Rao: Signed copy received`;
const ANDROID_12 = `06/11/2026, 2:05 pm - Messages and calls are end-to-end encrypted.
06/11/2026, 2:05 pm - Asha Rao: Demo done for Acme ops team
06/11/2026, 2:30 PM - Rohan: Great session, approved pilot`;
const ANDROID_24 = `06/11/26, 14:05 - Asha Rao: Kickoff call 45 min
06/11/26, 14:50 - Rohan: <Media omitted>
06/11/26, 15:00 - Rohan: This message was deleted
07/11/26, 10:00 - Rohan: Thanks, PO raised`;

describe("WhatsApp export parser", () => {
  it("parses the iOS format with multi-line messages and drops attachments", () => {
    const m = parseWhatsApp(IOS);
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({ at: "2026-11-06T14:05:33+05:30", author: "Asha Rao", text: "Sent the revised SOW to Acme" });
    expect(m[1].text).toBe("Got it, we sign Friday.\nAlso loop in finance");
    expect(m[2].at.slice(0, 10)).toBe("2026-11-07");
  });

  it("parses Android 12-hour (am/pm) and drops system lines", () => {
    const m = parseWhatsApp(ANDROID_12);
    expect(m.map((x) => [x.at, x.author])).toEqual([["2026-11-06T14:05:00+05:30", "Asha Rao"], ["2026-11-06T14:30:00+05:30", "Rohan"]]);
  });

  it("parses Android 24-hour and drops media/deleted placeholders", () => {
    const m = parseWhatsApp(ANDROID_24);
    expect(m.map((x) => x.text)).toEqual(["Kickoff call 45 min", "Thanks, PO raised"]);
    expect(looksLikeWhatsApp(ANDROID_24)).toBe(true);
    expect(looksLikeWhatsApp("just some notes\nno timestamps")).toBe(false);
  });

  it("chunks by day and splits long days at 40 messages", () => {
    const many = Array.from({ length: 85 }, (_, i) => `[06/11/26, 10:${String(i % 60).padStart(2, "0")}:00] A: m${i}`).join("\n") + "\n[07/11/26, 09:00:00] B: next day";
    const chunks = chunkMessages(parseWhatsApp(many));
    expect(chunks.map((c) => [c.day, c.messages.length])).toEqual([["2026-11-06", 40], ["2026-11-06", 40], ["2026-11-06", 5], ["2026-11-07", 1]]);
    expect(chunks[3].text).toBe("09:00 B: next day");
  });

  it("reads a WhatsApp .zip and replaces names with Person N", () => {
    const zip = zipSync({ "_chat.txt": strToU8(IOS), "00000012-PHOTO.jpg": new Uint8Array([1, 2, 3]) });
    const msgs = pseudonymise(parseWhatsApp(exportText("WhatsApp Chat - Acme.zip", zip)));
    expect([...new Set(msgs.map((m) => m.author))]).toEqual(["Person 1", "Person 2"]);
    expect(exportText("chat.txt", strToU8(ANDROID_24))).toBe(ANDROID_24);
  });
});

describe("GitHub mapping", () => {
  const ctx = { cycleId: "cyc_2026h2", logins: parseLoginMap("asha-dev=emp_dev_a, Ben=emp_dev_b") };
  const repository = { full_name: "acme/core" };

  it("verifies X-Hub-Signature-256 in constant time", () => {
    const body = '{"zen":"ok"}';
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignature("s3cret", body, sig)).toBe(true);
    expect(verifySignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
    expect(verifySignature("", body, sig)).toBe(false);
  });

  it("merged PR -> pr_merged deliverables:1 for the author; unmerged close is skipped", () => {
    const pr = { number: 101, merged: true, merged_at: "2026-11-06T10:00:00Z", title: "Add retries", user: { login: "Asha-Dev" }, html_url: "u" };
    expect(mapGithubEvent("pull_request", { action: "closed", pull_request: pr, repository }, ctx).drafts).toEqual([
      expect.objectContaining({ employee_id: "emp_dev_a", source: "github", kind: "pr_merged", ref: "gh:acme/core#101", observations: [{ metric_key: "deliverables", value: 1 }] }),
    ]);
    expect(mapGithubEvent("pull_request", { action: "closed", pull_request: { ...pr, merged: false }, repository }, ctx).drafts).toEqual([]);
    expect(mapGithubEvent("pull_request", { action: "opened", pull_request: pr, repository }, ctx).drafts).toEqual([]);
  });

  it("revert PR -> pr_reverted pointing at the reverted PR", () => {
    const pr = { number: 140, merged: true, merged_at: "2026-11-07T10:00:00Z", title: 'Revert "Add retries"', body: "Reverts acme/core#101", user: { login: "ben" } };
    const [d] = mapGithubEvent("pull_request", { action: "closed", pull_request: pr, repository }, ctx).drafts;
    expect(d).toMatchObject({ employee_id: "emp_dev_b", kind: "pr_reverted", reverts_ref: "gh:acme/core#101", observations: [] });
  });

  it("approved review -> review_done for the reviewer; self-review and comments are skipped", () => {
    const pull_request = { number: 101, user: { login: "asha-dev" }, html_url: "u" };
    const review = { id: 9, state: "APPROVED", submitted_at: "2026-11-06T09:00:00Z", user: { login: "ben" } };
    expect(mapGithubEvent("pull_request_review", { action: "submitted", review, pull_request, repository }, ctx).drafts[0]).toMatchObject({
      employee_id: "emp_dev_b", kind: "review_done", ref: "gh:acme/core#101/review/9", observations: [{ metric_key: "code_reviews", value: 1 }],
    });
    expect(mapGithubEvent("pull_request_review", { action: "submitted", review: { ...review, user: { login: "asha-dev" } }, pull_request, repository }, ctx).skipped).toBe("self-review");
    expect(mapGithubEvent("pull_request_review", { action: "submitted", review: { ...review, state: "COMMENTED" }, pull_request, repository }, ctx).drafts).toEqual([]);
  });

  it("closed bug issue -> tickets/bug_fixed with severity from labels", () => {
    const issue = { number: 7, closed_at: "2026-11-06T12:00:00Z", labels: [{ name: "bug" }, { name: "P1" }], assignee: { login: "asha-dev" }, state_reason: "completed" };
    expect(mapGithubEvent("issues", { action: "closed", issue, repository }, ctx).drafts[0]).toMatchObject({
      employee_id: "emp_dev_a", source: "tickets", kind: "bug_fixed", severity: "P1", share_bps: 10000, self_introduced: false, ref: "gh:acme/core/issues/7",
    });
    expect(mapGithubEvent("issues", { action: "closed", issue: { ...issue, state_reason: "not_planned" }, repository }, ctx).drafts).toEqual([]);
    expect(mapGithubEvent("issues", { action: "closed", issue: { ...issue, labels: [{ name: "feature" }] }, repository }, ctx).drafts).toEqual([]);
  });

  it("unlinked logins and unscored events produce nothing", () => {
    const pr = { number: 1, merged: true, merged_at: "2026-11-06T10:00:00Z", title: "x", user: { login: "stranger" } };
    expect(mapGithubEvent("pull_request", { action: "closed", pull_request: pr, repository }, ctx).skipped).toMatch(/unlinked/);
    expect(mapGithubEvent("release", { action: "published", repository }, ctx).skipped).toMatch(/not scored/);
  });
});

describe("link codes", () => {
  it("round-trips, fits Telegram /start, rejects tampering and expiry", () => {
    const code = makeLinkCode("a-long-link-secret", "p_dev_a", 2_000_000_000);
    expect(code).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(readLinkCode("a-long-link-secret", code, 1_900_000_000)).toBe("p_dev_a");
    expect(readLinkCode("a-long-link-secret", code, 2_000_000_001)).toBeNull();
    expect(readLinkCode("another-secret!!", code, 1_900_000_000)).toBeNull();
    const forged = makeLinkCode("a-long-link-secret", "p_dev_a", 2_000_000_000).replace(/^[0-9a-f]+/, Buffer.from("p_hr").toString("hex"));
    expect(readLinkCode("a-long-link-secret", forged, 1_900_000_000)).toBeNull();
  });
});
