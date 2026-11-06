# CHANGE_REQUESTS.md

The only way to change anything under `spec/`, `INTEGRATION.md`, `packages/crypto`, or an interface the other agent consumes.
Process: INTEGRATION.md section 2.1. Keep entries short. Newest at the bottom. Status: `proposed` -> `acked` | `objected` -> `merged` | `withdrawn`.

## Template (copy)
```
### CR-NNN  <title>
- Proposer: A | B        Date/time (IST):
- Kind: additive | breaking
- Problem: (what failed or is missing, with evidence)
- Proposal: (exact change: file, field, enum value, signature)
- Impact on the other agent: (what they must change, if anything)
- Workaround until merged:
- Status: proposed
- Other agent reply: ack | object (why)
- Merged in: commit hash, spec VERSION
```

## Pre-registered likely CRs (do not file until the trigger happens)
| Trigger | Likely CR |
|---|---|
| U1 resolves: Agent Pass needs extra fields from the server (e.g. an `rp_context` or signed request) | add optional fields to `Approval` and `CosignView` (additive) |
| U4: Arc USDC interface is not 6 decimals or has no ERC-20 `decimals()` | vault asset decimals rule + `Amount` documentation (breaking only if base-unit meaning changes) |
| U5: Studio compiler older than the interface pragma | pragma already `^0.8.0`; only needed if a feature of the interface requires newer |
| Contract implementation needs an extra argument in `registerPlan` (e.g. token override) | additive overload, never a signature change |

## Log

(empty - first entry is CR-001)

### CR-001  Optional `ai_flags` on CosignView
- Proposer: A        Date/time (IST): Fri 6 Nov 2026
- Kind: additive
- Problem: AGENT_A 3.9 / INTEGRATION F1.8 say the co-signer sees the claim's AI flags (e.g. `prompt_injection_suspected`, demo c2), but `CosignView` is `additionalProperties: false` without an `ai_flags` field, so the API cannot return them to the co-signer.
- Proposal: `spec/openapi.yaml` `CosignView.properties.ai_flags`: same schema as `Claim.ai_flags` (array of enum `prompt_injection_suspected | low_confidence | fields_inferred`), optional.
- Impact on the other agent: none required; B may render the flags on `/cosign` once merged.
- Workaround until merged: flags are on `Claim` (visible to the employee and their manager); the co-signer page cannot show them yet.
- Status: proposed
- Other agent reply:
- Merged in:
