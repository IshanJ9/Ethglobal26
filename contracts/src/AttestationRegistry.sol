// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {AccessControl} from "./lib/AccessControl.sol";

/// @title AttestationRegistry
/// @notice Anchors Merkle roots of evidence commitments and records scorecard attestations with revisions.
/// Stores only commitments, roots, pseudonymous subject ids and basis points - never names, raw claims or
/// scores in clear (spec/HASHING.md, INTEGRATION 7).
/// Revert reasons match the backend's MockChain so mock and live report the same errors.
contract AttestationRegistry is IAttestationRegistry, AccessControl {
    bytes32 public constant override ANCHOR_ROLE = keccak256("ANCHOR_ROLE");
    bytes32 public constant override ATTESTER_ROLE = keccak256("ATTESTER_ROLE");

    /// @notice Upper bound on the payout multiplier (300%), shared with the backend.
    uint16 public constant MAX_MULTIPLIER_BPS = 30000;

    mapping(uint64 => bytes32) private _batchRoot;
    Attestation[] private _attestations; // id = index + 1
    mapping(bytes32 => mapping(uint64 => uint256)) private _latest;

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ---------------------------------------------------------------- anchoring

    function anchorBatch(bytes32 root, uint64 batchId, uint32 count) external override onlyRole(ANCHOR_ROLE) {
        require(root != bytes32(0), "zero root");
        require(count > 0, "zero count");
        require(_batchRoot[batchId] == bytes32(0), "batch exists");
        _batchRoot[batchId] = root;
        emit BatchAnchored(batchId, root, count, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------- attestations

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
    ) external override onlyRole(ATTESTER_ROLE) returns (uint256 attestationId) {
        require(subjectId != bytes32(0), "zero subject");
        require(version >= 1, "bad version");
        require(multiplierBps <= MAX_MULTIPLIER_BPS, "multiplier too high");

        if (supersedes != 0) {
            Attestation storage old = _get(supersedes);
            require(!old.revoked, "superseded is revoked");
            require(old.subjectId == subjectId && old.cycleId == cycleId, "supersede subject/cycle mismatch");
            require(version > old.version, "version must increase");
            old.revoked = true;
            emit AttestationRevoked(supersedes, keccak256("superseded"));
        } else {
            require(_latest[subjectId][cycleId] == 0, "must supersede");
        }

        _attestations.push(
            Attestation({
                subjectId: subjectId,
                cycleId: cycleId,
                version: version,
                scoreCommitment: scoreCommitment,
                evidenceRoot: evidenceRoot,
                formulaHash: formulaHash,
                approvalProofHash: approvalProofHash,
                multiplierBps: multiplierBps,
                supersedes: supersedes,
                attestedAt: uint64(block.timestamp),
                revoked: false
            })
        );
        attestationId = _attestations.length;
        _latest[subjectId][cycleId] = attestationId;
        emit ScoreAttested(attestationId, subjectId, cycleId, version, multiplierBps, supersedes);
    }

    function revoke(uint256 attestationId, bytes32 reasonHash) external override onlyRole(ATTESTER_ROLE) {
        Attestation storage a = _get(attestationId);
        a.revoked = true;
        if (_latest[a.subjectId][a.cycleId] == attestationId) _latest[a.subjectId][a.cycleId] = 0;
        emit AttestationRevoked(attestationId, reasonHash);
    }

    // ---------------------------------------------------------------- views

    function getAttestation(uint256 attestationId) external view override returns (Attestation memory) {
        return _get(attestationId);
    }

    function batchRoot(uint64 batchId) external view override returns (bytes32) {
        return _batchRoot[batchId];
    }

    function latestAttestation(bytes32 subjectId, uint64 cycleId) external view override returns (uint256) {
        return _latest[subjectId][cycleId];
    }

    /// @notice Number of attestations ever recorded (ids are 1..count).
    function attestationCount() external view returns (uint256) {
        return _attestations.length;
    }

    function hasRole(bytes32 role, address account)
        public
        view
        override(AccessControl, IAttestationRegistry)
        returns (bool)
    {
        return super.hasRole(role, account);
    }

    function _get(uint256 id) private view returns (Attestation storage) {
        require(id >= 1 && id <= _attestations.length, "unknown attestation");
        return _attestations[id - 1];
    }
}
