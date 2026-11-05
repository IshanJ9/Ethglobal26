// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title IBonusVault - FROZEN INTERFACE (spec v1). USDC (6 decimals) escrow with holdback, malus and revision logic.
/// Amount math MUST equal spec/ENGINE.md (payout_split, revision) - see spec/vectors/vectors.json.
interface IBonusVault {
    enum PayoutStatus { None, Registered, Active, Disputed, Closed }

    struct PayoutState {
        address payee;
        uint256 targetBonus;      // base units of the asset
        uint16 holdbackBps;       // e.g. 2000 = 20%
        uint64 maturityAt;        // earliest releaseHoldback timestamp (set at first release)
        uint256 attestationId;    // attestation currently governing the payout
        uint256 entitlement;      // target * multiplierBps / 10000
        uint256 paid;             // total transferred so far
        uint256 held;             // amount still held back
        uint256 forfeited;        // total forfeited back to cycle pool (malus)
        uint256 overpaid;         // paid - entitlement when a revision lowers entitlement below paid (offset against future)
        PayoutStatus status;
    }

    event CycleFunded(uint64 indexed cycleId, uint256 amount, address indexed funder);
    event PlanRegistered(bytes32 indexed subjectId, uint64 indexed cycleId, address payee, uint256 targetBonus, uint16 holdbackBps, uint64 maturitySeconds);
    event Released(bytes32 indexed subjectId, uint64 indexed cycleId, uint256 attestationId, uint256 immediate, uint256 held);
    event HoldbackReleased(bytes32 indexed subjectId, uint64 indexed cycleId, uint256 amount);
    event Disputed(bytes32 indexed subjectId, uint64 indexed cycleId, bytes32 reasonHash);
    event DisputeResolved(bytes32 indexed subjectId, uint64 indexed cycleId, bool released);
    event RevisionApplied(bytes32 indexed subjectId, uint64 indexed cycleId, uint256 oldAttestationId, uint256 newAttestationId, uint256 heldRemaining, uint256 forfeited, uint256 extraOwed, uint256 overpaid);

    function asset() external view returns (address);
    function registry() external view returns (address);
    function PLANNER_ROLE() external view returns (bytes32);
    function PAYOUT_ROLE() external view returns (bytes32);
    function DISPUTER_ROLE() external view returns (bytes32);
    function RESOLVER_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);

    /// Pull `amount` of the asset from msg.sender (requires prior approve). Anyone may fund.
    function fundCycle(uint64 cycleId, uint256 amount) external;
    function cycleBalance(uint64 cycleId) external view returns (uint256);

    function registerPlan(bytes32 subjectId, uint64 cycleId, address payee, uint256 targetBonus, uint16 holdbackBps, uint64 maturitySeconds) external;

    /// Pays entitlement*(1-holdback) to payee for the attestation; the rest stays held. Reverts if attestation is revoked,
    /// does not match (subjectId, cycleId), or the multiplier is 0 (then it only records and closes).
    function release(uint256 attestationId) external;
    /// Pays `held` after maturity if not disputed.
    function releaseHoldback(uint256 attestationId) external;
    function dispute(uint256 attestationId, bytes32 reasonHash) external;
    function resolveDispute(uint256 attestationId, bool releaseFunds) external;
    /// Re-bases entitlement on a superseding attestation: forfeits/extends held per spec/ENGINE.md `revision`.
    function applyRevision(uint256 oldAttestationId, uint256 newAttestationId) external;

    function getPayout(bytes32 subjectId, uint64 cycleId) external view returns (PayoutState memory);
}
