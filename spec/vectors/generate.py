#!/usr/bin/env python3
"""
Reference generator for Proofwork golden vectors.

Python is the *independent* reference. The TypeScript package (@proofwork/crypto) and the JS reference engine
(spec/reference/engine.mjs) must reproduce every value here. Never hand-edit vectors.json: change this file,
bump spec/VERSION, re-run, and file a CHANGE_REQUEST.

Run:  python3 spec/vectors/generate.py
"""
import json
import os
from eth_utils import keccak
from eth_account import Account
from eth_account.messages import encode_typed_data

HERE = os.path.dirname(os.path.abspath(__file__))

# ----------------------------------------------------------------------------------------------
# Canonical JSON (RFC 8785-compatible for the restricted value space we allow):
# objects, arrays, strings, booleans, null, and SAFE INTEGERS only. No floats. ASCII object keys.
# ----------------------------------------------------------------------------------------------
MAX_SAFE = 2**53 - 1


def canon(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, bool):
        raise TypeError("bool")
    if isinstance(v, int):
        if abs(v) > MAX_SAFE:
            raise ValueError("integer outside safe range; send as decimal string")
        return str(v)
    if isinstance(v, float):
        raise ValueError("floats are forbidden in canonical JSON")
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, dict):
        for k in v:
            if not k.isascii():
                raise ValueError("non-ASCII object key")
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canon(v[k]) for k in sorted(v)) + "}"
    raise TypeError(type(v))


def h(b: bytes) -> str:
    return "0x" + keccak(b).hex()


def hx(s: str) -> bytes:
    return bytes.fromhex(s[2:])


# ----------------------------------------------------------------------------------------------
# Hash constructions (see spec/HASHING.md)
# ----------------------------------------------------------------------------------------------
def commitment(salt: str, value) -> str:
    return h(b"PW_COMMIT_V1" + hx(salt) + canon(value).encode("utf-8"))


def merkle_leaf(c: str) -> str:
    return h(b"\x00" + hx(c))


def merkle_node(a: str, b: str) -> str:
    x, y = (a, b) if int(a, 16) <= int(b, 16) else (b, a)
    return h(hx(x) + hx(y))


def merkle_build(commitments):
    leaves = sorted(merkle_leaf(c) for c in commitments)
    levels = [leaves]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = []
        for i in range(0, len(cur), 2):
            nxt.append(merkle_node(cur[i], cur[i + 1]) if i + 1 < len(cur) else cur[i])
        levels.append(nxt)
    return leaves, levels


def merkle_proof(levels, index):
    proof = []
    for lvl in levels[:-1]:
        sib = index ^ 1
        if sib < len(lvl):
            proof.append(lvl[sib])
        index //= 2
    return proof


def merkle_verify(c, proof, root):
    cur = merkle_leaf(c)
    for p in proof:
        cur = merkle_node(cur, p)
    return cur == root


def subject_id(org_secret: str, employee_id: str, cycle_id: int) -> str:
    return h(b"PW_SUBJECT_V1" + hx(org_secret) + employee_id.encode() + b"\x00" + cycle_id.to_bytes(8, "big"))


def score_commitment(salt: str, obj) -> str:
    return h(b"PW_SCORE_V1" + hx(salt) + canon(obj).encode("utf-8"))


def event_hash(prev: str, core) -> str:
    return h(hx(prev) + canon(core).encode("utf-8"))


def persona_key(persona_id: str) -> str:
    return h(("proofwork-demo-persona:" + persona_id).encode())


# ----------------------------------------------------------------------------------------------
# Scoring engine (see spec/ENGINE.md). All integer arithmetic, floor division on non-negative numbers.
# ----------------------------------------------------------------------------------------------
PPM = 1_000_000


def attainment_ppm(direction, actual, target, cap_ppm):
    assert target > 0 and actual >= 0
    if direction == "higher_better":
        return actual * PPM // target
    if actual == 0:
        return cap_ppm
    return target * PPM // actual


def curve_interp(curve, x):
    # curve: list of [x_bps, y_bps], x strictly increasing, y non-decreasing
    if x <= curve[0][0]:
        return curve[0][1]
    if x >= curve[-1][0]:
        return curve[-1][1]
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        if x0 <= x <= x1:
            return y0 + ((x - x0) * (y1 - y0)) // (x1 - x0)
    raise AssertionError


def weighted_scorecard(kras, curve, verified_ratio_bps=10000, min_verified_ratio_bps=0, target_bonus=0):
    lines, total = [], 0
    for k in kras:
        att = attainment_ppm(k["direction"], k["actual"], k["target"], k["cap_ppm"])
        capped = min(max(att, k["floor_ppm"]), k["cap_ppm"])
        contrib = k["weight_bps"] * capped // 10_000
        total += contrib
        lines.append({"kra_id": k["kra_id"], "attainment_ppm": att, "capped_ppm": capped, "contribution_ppm": contrib})
    score_bps = (total + 50) // 100
    gate = verified_ratio_bps >= min_verified_ratio_bps
    mult = curve_interp(curve, score_bps) if gate else 0
    return {
        "lines": lines,
        "score_ppm": total,
        "score_bps": score_bps,
        "gate_passed": gate,
        "multiplier_bps": mult,
        "bonus_amount": str(target_bonus * mult // 10_000),
    }


def tiered_commission(quota, sales, rate_bps, accelerator_bps, retention_bps=10_000):
    base = min(sales, quota) * rate_bps // 10_000
    excess = max(sales - quota, 0) * rate_bps * accelerator_bps // 100_000_000
    return {
        "attainment_bps": sales * 10_000 // quota,
        "base": base,
        "accelerated": excess,
        "payout": (base + excess) * retention_bps // 10_000,
    }


def bug_credit(fixes, policy):
    by_tier = {}
    for f in fixes:
        cfg = policy["severity"][f["severity"]]
        v = cfg["weight_milli"]
        v = v * f.get("impact_bps", 10_000) // 10_000
        v = v * f.get("share_bps", 10_000) // 10_000
        if f.get("self_introduced"):
            v = 0
        by_tier.setdefault(f["severity"], []).append(v)
    total, tiers = 0, {}
    for sev, vals in by_tier.items():
        cfg = policy["severity"][sev]
        vals = sorted(vals, reverse=True)
        s = 0
        for i, v in enumerate(vals):
            s += v if i < cfg["full_credit_count"] else v * policy["taper_bps"] // 10_000
        tiers[sev] = min(s, cfg["tier_cap_milli"])
        total += tiers[sev]
    return {"tiers_milli": tiers, "total_milli": total}


def payout_split(target_bonus, multiplier_bps, holdback_bps):
    ent = target_bonus * multiplier_bps // 10_000
    immediate = ent * (10_000 - holdback_bps) // 10_000
    return {"entitlement": str(ent), "immediate": str(immediate), "held": str(ent - immediate)}


def carry_blend(cur_bps, prior_bps, w_bps):
    return (cur_bps * (10000 - w_bps) + prior_bps * w_bps) // 10000


def revision(target_bonus, paid, held, new_multiplier_bps):
    ent = target_bonus * new_multiplier_bps // 10_000
    held_remaining = max(0, ent - paid)
    return {
        "new_entitlement": str(ent),
        "held_remaining": str(held_remaining),
        "overpaid": str(max(0, paid - ent)),
        "forfeited": str(max(0, held - held_remaining)),
        "extra_owed": str(max(0, held_remaining - held)),
    }


# ----------------------------------------------------------------------------------------------
# Build vectors
# ----------------------------------------------------------------------------------------------
def build():
    out = {"spec_version": "1.2.0", "note": "GENERATED by spec/vectors/generate.py - do not edit by hand."}

    # canonical JSON
    cj_inputs = [
        {"b": 1, "a": [True, None, "x"]},
        {"summary": "Client call with Acme CFO ₹ pricing – नमस्ते", "n": -7, "z": 0},
        {"nested": {"y": {"b": "line\nbreak \"quoted\" back\\slash\ttab", "a": ""}}, "arr": [[], {}, [1, [2]]]},
    ]
    out["canonical_json"] = [{"input": v, "canonical": canon(v), "keccak": h(canon(v).encode())} for v in cj_inputs]

    # commitments
    salts = ["0x" + "11" * 32, "0x" + "ab" * 32]
    claim = {
        "schema": "pw.claim.v1",
        "kind": "client_call",
        "summary": "Agreed revised onboarding timeline with Acme CFO",
        "occurred_on": "2026-10-14",
        "duration_minutes": 45,
        "counterparty_label": "Acme Bank CFO",
    }
    out["commitments"] = [
        {"salt": salts[0], "value": claim, "commitment": commitment(salts[0], claim)},
        {"salt": salts[1], "value": {"excerpt": "Call notes: timeline moves to Q1"}, "commitment": commitment(salts[1], {"excerpt": "Call notes: timeline moves to Q1"})},
    ]

    # merkle (odd count to cover promotion)
    cs = [commitment("0x" + f"{i:02x}" * 32, {"i": i}) for i in range(1, 6)]
    leaves, levels = merkle_build(cs)
    proofs = {}
    for c in cs:
        idx = leaves.index(merkle_leaf(c))
        pr = merkle_proof(levels, idx)
        assert merkle_verify(c, pr, levels[-1][0])
        proofs[c] = pr
    single_leaves, single_levels = merkle_build(cs[:1])
    out["merkle"] = {
        "commitments": cs,
        "sorted_leaves": leaves,
        "root": levels[-1][0],
        "proofs": proofs,
        "single": {"commitment": cs[0], "root": single_levels[-1][0], "proof": []},
        "tamper_negative": {"commitment": commitment("0x" + "99" * 32, {"i": 99}), "must_not_verify_against": levels[-1][0]},
    }

    # subject id / score commitment / hash chain
    org_secret = "0x" + "5e" * 32
    out["subject_id"] = {
        "org_secret": org_secret,
        "employee_id": "00000000-0000-4000-8000-0000000000a1",
        "cycle_id": 2026,
        "subject_id": subject_id(org_secret, "00000000-0000-4000-8000-0000000000a1", 2026),
    }
    sc_obj = {
        "cycle_id": 2026,
        "employee_id": "00000000-0000-4000-8000-0000000000a1",
        "evidence_root": levels[-1][0],
        "formula_hash": "0x" + "fa" * 32,
        "multiplier_bps": 10000,
        "score_bps": 10145,
        "version": 1,
    }
    sc_salt = "0x" + "c3" * 32
    out["score_commitment"] = {"salt": sc_salt, "value": sc_obj, "commitment": score_commitment(sc_salt, sc_obj)}
    zero = "0x" + "00" * 32
    cores = [{"seq": 1, "kind": "pr_merged", "ref": "gh:acme/core#101"}, {"seq": 2, "kind": "pr_reverted", "ref": "gh:acme/core#101"}, {"seq": 3, "kind": "bug_fixed", "ref": "JIRA-9"}]
    prev, chain = zero, []
    for c in cores:
        eh = event_hash(prev, c)
        chain.append({"prev_hash": prev, "core": c, "event_hash": eh})
        prev = eh
    out["hash_chain"] = chain

    # EIP-712
    employee_key = persona_key("p_dev_a")
    cosigner_key = persona_key("p_client_cfo")
    emp = Account.from_key(employee_key)
    cos = Account.from_key(cosigner_key)
    ev_salt = "0x" + "22" * 32
    ev_value = {"excerpt": "CFO: we can move go-live to January if the API is ready by 15 Dec"}
    kra_id = "client_engagement"
    message = {
        "employee": emp.address,
        "claimCommitment": commitment(salts[0], claim),
        "evidenceCommitment": commitment(ev_salt, ev_value),
        "cycleId": 2026,
        "kraId": h(kra_id.encode()),
        "cosigner": cos.address,
        "nonce": 1,
        "deadline": 1893456000,
    }
    domain = {"name": "Proofwork", "version": "1", "chainId": 31337, "verifyingContract": "0x5FbDB2315678afecb367f032d93F642f64180aa3"}
    types = {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"},
        ],
        "Claim": [
            {"name": "employee", "type": "address"},
            {"name": "claimCommitment", "type": "bytes32"},
            {"name": "evidenceCommitment", "type": "bytes32"},
            {"name": "cycleId", "type": "uint64"},
            {"name": "kraId", "type": "bytes32"},
            {"name": "cosigner", "type": "address"},
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint64"},
        ],
    }
    full = {"types": types, "primaryType": "Claim", "domain": domain, "message": message}
    signable = encode_typed_data(full_message=full)
    digest = "0x" + keccak(b"\x19" + signable.version + signable.header + signable.body).hex()
    sig_emp = Account.sign_message(signable, employee_key).signature.hex()
    sig_cos = Account.sign_message(signable, cosigner_key).signature.hex()
    out["eip712"] = {
        "TEST_ONLY_WARNING": "chainId/verifyingContract are dummy test values. Real values come from /v1/config/public.",
        "kra_id_string": kra_id,
        "claim_value": claim,
        "claim_salt": salts[0],
        "evidence_value": ev_value,
        "evidence_salt": ev_salt,
        "domain": domain,
        "types": {"Claim": types["Claim"]},
        "primaryType": "Claim",
        "message": message,
        "digest": digest,
        "employee_persona": "p_dev_a",
        "employee_private_key": employee_key,
        "employee_signature": "0x" + sig_emp if not sig_emp.startswith("0x") else sig_emp,
        "cosigner_persona": "p_client_cfo",
        "cosigner_private_key": cosigner_key,
        "cosigner_signature": "0x" + sig_cos if not sig_cos.startswith("0x") else sig_cos,
    }

    # personas
    pids = ["p_dev_a", "p_dev_b", "p_dev_c", "p_eng_mgr", "p_ae", "p_sales_mgr", "p_mkt_exec", "p_mkt_mgr", "p_hr", "p_client_cfo"]
    out["persona_addresses"] = {p: Account.from_key(persona_key(p)).address for p in pids}
    out["persona_key_rule"] = "private_key = keccak256(utf8('proofwork-demo-persona:' + persona_id)). DEMO ONLY - never holds real funds."

    # ---------------- scoring ----------------
    curve = [[0, 0], [7000, 5000], [9000, 10000], [11000, 10000], [13000, 15000]]
    out["payout_curve_default"] = curve
    out["curve_cases"] = [{"score_bps": s, "multiplier_bps": curve_interp(curve, s)} for s in [0, 3000, 6999, 7000, 8000, 9000, 10145, 11000, 12000, 13000, 14000]]

    mkt = [
        {"kra_id": "sourced_pipeline", "weight_bps": 4000, "direction": "higher_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 2_000_000, "actual": 2_300_000},
        {"kra_id": "mql_to_sql", "weight_bps": 2000, "direction": "higher_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 1500, "actual": 1200},
        {"kra_id": "cost_per_sql", "weight_bps": 2000, "direction": "lower_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 500, "actual": 450},
        {"kra_id": "campaign_milestones", "weight_bps": 2000, "direction": "higher_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 10, "actual": 8},
    ]
    eng_v1 = [
        {"kra_id": "deliverables", "weight_bps": 4000, "direction": "higher_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 20, "actual": 18},
        {"kra_id": "code_reviews", "weight_bps": 1500, "direction": "higher_better", "floor_ppm": 0, "cap_ppm": 1_100_000, "target": 40, "actual": 45},
        {"kra_id": "service_cfr", "weight_bps": 2500, "direction": "lower_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 1500, "actual": 1000},
        {"kra_id": "incident_sla", "weight_bps": 2000, "direction": "higher_better", "floor_ppm": 0, "cap_ppm": 1_200_000, "target": 9500, "actual": 9000},
    ]
    eng_v2 = [dict(k) for k in eng_v1]
    eng_v2[0]["actual"] = 17
    TB = 5_000_000_000  # 5,000 USDC in 6-decimal base units
    cases = []
    for name, kras, kw in [
        ("marketing_exec_v1", mkt, {}),
        ("engineer_v1", eng_v1, {}),
        ("engineer_v2_after_revert", eng_v2, {}),
        ("engineer_gate_fail", eng_v1, {"verified_ratio_bps": 7000, "min_verified_ratio_bps": 8000}),
    ]:
        res = weighted_scorecard(kras, curve, target_bonus=TB, **kw)
        cases.append({"name": name, "formula": "weighted_scorecard", "kras": kras, "payout_curve": curve, "target_bonus": str(TB), **kw, "expected": res})
    out["weighted_scorecard_cases"] = cases

    out["tiered_commission_cases"] = [
        {"name": "ae_115pct", "quota": 800000, "sales": 920000, "rate_bps": 500, "accelerator_bps": 15000, "retention_bps": 10000},
        {"name": "ae_75pct", "quota": 800000, "sales": 600000, "rate_bps": 500, "accelerator_bps": 15000, "retention_bps": 10000},
        {"name": "ae_115pct_retention_90", "quota": 800000, "sales": 920000, "rate_bps": 500, "accelerator_bps": 15000, "retention_bps": 9000},
    ]
    for c in out["tiered_commission_cases"]:
        c["expected"] = tiered_commission(c["quota"], c["sales"], c["rate_bps"], c["accelerator_bps"], c["retention_bps"])

    policy = {
        "severity": {
            "P0": {"weight_milli": 40_000, "full_credit_count": 3, "tier_cap_milli": 120_000},
            "P1": {"weight_milli": 15_000, "full_credit_count": 4, "tier_cap_milli": 60_000},
            "P2": {"weight_milli": 5_000, "full_credit_count": 5, "tier_cap_milli": 25_000},
            "P3": {"weight_milli": 1_000, "full_credit_count": 5, "tier_cap_milli": 10_000},
        },
        "taper_bps": 5000,
        "share_defaults": {"finder_bps": 2000, "fixer_bps": 6000, "reviewer_bps": 2000},
    }
    bc_cases = [
        {"name": "dev_a_one_p0", "fixes": [{"severity": "P0"}]},
        {"name": "dev_b_twenty_p3", "fixes": [{"severity": "P3"}] * 20},
        {"name": "dev_c_four_p0_capped", "fixes": [{"severity": "P0"}] * 4},
        {"name": "self_introduced_p0_zero", "fixes": [{"severity": "P0", "self_introduced": True}]},
        {"name": "fixer_share_60pct", "fixes": [{"severity": "P1", "share_bps": 6000}]},
    ]
    for c in bc_cases:
        c["expected"] = bug_credit(c["fixes"], policy)
    out["bug_credit"] = {"policy": policy, "cases": bc_cases}

    out["payout_split_cases"] = [{"target_bonus": str(TB), "multiplier_bps": 10000, "holdback_bps": 2000, "expected": payout_split(TB, 10000, 2000)}]
    out["revision_cases"] = [
        {"name": "downward_big", "target_bonus": str(TB), "paid": "4000000000", "held": "1000000000", "new_multiplier_bps": 7500},
        {"name": "downward_small", "target_bonus": str(TB), "paid": "4000000000", "held": "1000000000", "new_multiplier_bps": 9500},
        {"name": "upward", "target_bonus": str(TB), "paid": "4000000000", "held": "1000000000", "new_multiplier_bps": 12000},
    ]
    for c in out["revision_cases"]:
        c["expected"] = revision(int(c["target_bonus"]), int(c["paid"]), int(c["held"]), c["new_multiplier_bps"])

    out["carry_forward_cases"] = [
        {"cur_bps": 10145, "prior_bps": 8000, "w_bps": 2000},
        {"cur_bps": 9500, "prior_bps": 10000, "w_bps": 3000},
        {"cur_bps": 10001, "prior_bps": 9999, "w_bps": 3333},
        {"cur_bps": 9000, "prior_bps": 9000, "w_bps": 0},
    ]
    for c in out["carry_forward_cases"]:
        c["blended_bps"] = carry_blend(c["cur_bps"], c["prior_bps"], c["w_bps"])

    return out


if __name__ == "__main__":
    v = build()
    path = os.path.join(HERE, "vectors.json")
    with open(path, "w") as f:
        json.dump(v, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    print("wrote", path)
