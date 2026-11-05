// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title IAttestationRegistry - FROZEN INTERFACE (spec v1). Agent B implements it in Arc Studio; Agent A calls it.
/// Any change goes through CHANGE_REQUESTS.md. Studio's exported ABI must be a SUPERSET of spec/abi/IAttestationRegistry.json
/// (verified by scripts/check-abi.mjs). Only commitments, roots and pseudonymous ids are stored - never names or scores.
interface IAttestationRegistry {
    struct Attestation {
        bytes32 subjectId;        // pseudonymous per-cycle id (see spec/HASHING.md)
        uint64 cycleId;
        uint32 version;           // 1, 2, 3 ... (revisions)
        bytes32 scoreCommitment;  // salted commitment to the scorecard JSON
        bytes32 evidenceRoot;     // Merkle root of evidence commitments used for this score
        bytes32 formulaHash;      // hash of the plan/formula used
        bytes32 approvalProofHash;// hash of the human approval record (incl. World result)
        uint16 multiplierBps;     // payout multiplier in basis points, 10000 = 100%
        uint256 supersedes;       // attestation id this one replaces, 0 if none
        uint64 attestedAt;
        bool revoked;
    }

    event BatchAnchored(uint64 indexed batchId, bytes32 root, uint32 count, uint64 anchoredAt);
    event ScoreAttested(uint256 indexed attestationId, bytes32 indexed subjectId, uint64 indexed cycleId, uint32 version, uint16 multiplierBps, uint256 supersedes);
    event AttestationRevoked(uint256 indexed attestationId, bytes32 reasonHash);

    function ANCHOR_ROLE() external view returns (bytes32);
    function ATTESTER_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);

    /// Anchor a Merkle root of evidence/ledger commitments. batchId is chosen by the backend and must be unused.
    function anchorBatch(bytes32 root, uint64 batchId, uint32 count) external;

    /// Attest a scorecard version. If supersedes != 0 the old attestation is marked revoked in the same call.
    /// Returns the new attestation id (starts at 1).
    function attestScore(
        bytes32 subjectId,
        uint64 cycleId,
        uint32 version,
        bytes32 scoreCommitment,
        bytes32 evidenceRoot,
        bytes32 formulaHash,
        bytes32 approvalProofHash,
        uint16 multiplierBps,
        uint256 supersedes
    ) external returns (uint256 attestationId);

    function revoke(uint256 attestationId, bytes32 reasonHash) external;

    function getAttestation(uint256 attestationId) external view returns (Attestation memory);
    function batchRoot(uint64 batchId) external view returns (bytes32);
    /// Latest NON-revoked attestation id for (subjectId, cycleId); 0 if none.
    function latestAttestation(bytes32 subjectId, uint64 cycleId) external view returns (uint256);
}
