// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IScoreThresholdVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[3] calldata pub)
        external
        view
        returns (bool);
}

interface IBatchRoots {
    function batchRoot(uint64 batchId) external view returns (bytes32);
}

/// @title ScoreProofRegistry
/// @notice Permanent, public record of zero-knowledge score proofs. A record exists only if (1) the Groth16 proof
/// verifies on chain, and (2) its commitment is the one the company anchored in the AttestationRegistry. Anyone can
/// then check "this scorecard's score is at least T" without learning the score.
/// Public signals: [commitment = Poseidon(score, salt, binding), threshold_bps, binding = keccak(scorecard_id) >> 8].
contract ScoreProofRegistry {
    IScoreThresholdVerifier public immutable verifier;
    IBatchRoots public immutable registry;

    struct Proven {
        uint64 batchId;
        uint64 provenAt;
        address submitter;
    }

    /// key = keccak256(abi.encode(commitment, threshold))
    mapping(bytes32 => Proven) public proven;
    /// best (highest) proven threshold per commitment
    mapping(uint256 => uint256) public bestThreshold;

    event ScoreProven(uint256 indexed commitment, uint256 indexed binding, uint256 threshold, uint64 batchId, address submitter);

    constructor(IScoreThresholdVerifier verifier_, IBatchRoots registry_) {
        verifier = verifier_;
        registry = registry_;
    }

    function keyOf(uint256 commitment, uint256 threshold) public pure returns (bytes32) {
        return keccak256(abi.encode(commitment, threshold));
    }

    function record(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata pub,
        uint64 batchId
    ) external returns (bytes32 key) {
        key = keyOf(pub[0], pub[1]);
        if (proven[key].provenAt != 0) return key; // idempotent
        require(registry.batchRoot(batchId) == bytes32(pub[0]), "commitment not anchored");
        require(verifier.verifyProof(a, b, c, pub), "invalid proof");
        proven[key] = Proven(batchId, uint64(block.timestamp), msg.sender);
        if (pub[1] > bestThreshold[pub[0]]) bestThreshold[pub[0]] = pub[1];
        emit ScoreProven(pub[0], pub[2], pub[1], batchId, msg.sender);
    }

    function isProven(uint256 commitment, uint256 threshold) external view returns (bool) {
        return proven[keyOf(commitment, threshold)].provenAt != 0;
    }
}
