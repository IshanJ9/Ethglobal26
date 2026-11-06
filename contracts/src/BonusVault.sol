// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IBonusVault} from "./interfaces/IBonusVault.sol";
import {IAttestationRegistry} from "./interfaces/IAttestationRegistry.sol";
import {AccessControl} from "./lib/AccessControl.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {IERC20Metadata, SafeERC20} from "./lib/SafeERC20.sol";

/// @title BonusVault
/// @notice USDC escrow per (subject, cycle) with holdback, dispute, malus and revision.
/// Amount math is exactly spec/ENGINE.md `payout_split` and `revision` (golden cases in spec/vectors/vectors.json).
/// Funds move only against a non-revoked attestation that governs the payout; revert reasons match the
/// backend's MockChain.
///
/// Accounting invariant: asset.balanceOf(this) >= sum(cycleBalance) + sum(held).
/// fundCycle adds to cycleBalance; release reserves the entitlement from cycleBalance, pays the immediate part
/// and keeps the rest as `held`; forfeits return to cycleBalance; extraOwed moves from cycleBalance to `held`.
contract BonusVault is IBonusVault, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;

    bytes32 public constant override PLANNER_ROLE = keccak256("PLANNER_ROLE");
    bytes32 public constant override PAYOUT_ROLE = keccak256("PAYOUT_ROLE");
    bytes32 public constant override DISPUTER_ROLE = keccak256("DISPUTER_ROLE");
    bytes32 public constant override RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    uint256 private constant BPS = 10000;

    address public immutable override asset;
    address public immutable override registry;

    mapping(uint64 => uint256) public override cycleBalance;
    mapping(bytes32 => mapping(uint64 => PayoutState)) private _payouts;
    mapping(bytes32 => mapping(uint64 => uint64)) private _maturitySeconds;

    constructor(address asset_, address registry_) {
        require(asset_ != address(0) && registry_ != address(0), "zero address");
        require(IERC20Metadata(asset_).decimals() == 6, "asset must have 6 decimals");
        asset = asset_;
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ---------------------------------------------------------------- funding and plans

    function fundCycle(uint64 cycleId, uint256 amount) external override nonReentrant {
        require(amount > 0, "zero amount");
        IERC20Metadata(asset).safeTransferFrom(msg.sender, address(this), amount);
        cycleBalance[cycleId] += amount;
        emit CycleFunded(cycleId, amount, msg.sender);
    }

    function registerPlan(
        bytes32 subjectId,
        uint64 cycleId,
        address payee,
        uint256 targetBonus,
        uint16 holdbackBps,
        uint64 maturitySeconds
    ) external override onlyRole(PLANNER_ROLE) {
        PayoutState storage p = _payouts[subjectId][cycleId];
        require(p.status == PayoutStatus.None, "already registered");
        require(payee != address(0), "zero payee");
        require(holdbackBps <= BPS, "bad holdback");
        p.payee = payee;
        p.targetBonus = targetBonus;
        p.holdbackBps = holdbackBps;
        p.status = PayoutStatus.Registered;
        _maturitySeconds[subjectId][cycleId] = maturitySeconds;
        emit PlanRegistered(subjectId, cycleId, payee, targetBonus, holdbackBps, maturitySeconds);
    }

    // ---------------------------------------------------------------- payouts

    function release(uint256 attestationId) external override nonReentrant onlyRole(PAYOUT_ROLE) {
        IAttestationRegistry.Attestation memory a = _attestation(attestationId);
        require(!a.revoked, "attestation revoked");
        PayoutState storage p = _plan(a);
        require(p.status == PayoutStatus.Registered, "not in Registered state");

        uint256 ent = (p.targetBonus * a.multiplierBps) / BPS;
        uint256 immediate = (ent * (BPS - p.holdbackBps)) / BPS;
        require(cycleBalance[a.cycleId] >= ent, "insufficient cycle balance");
        cycleBalance[a.cycleId] -= ent;

        p.attestationId = attestationId;
        p.entitlement = ent;
        p.paid = immediate;
        p.held = ent - immediate;
        p.maturityAt = uint64(block.timestamp) + _maturitySeconds[a.subjectId][a.cycleId];
        p.status = ent == 0 ? PayoutStatus.Closed : PayoutStatus.Active;

        if (immediate > 0) IERC20Metadata(asset).safeTransfer(p.payee, immediate);
        emit Released(a.subjectId, a.cycleId, attestationId, immediate, p.held);
    }

    function releaseHoldback(uint256 attestationId) external override nonReentrant onlyRole(PAYOUT_ROLE) {
        IAttestationRegistry.Attestation memory a = _attestation(attestationId);
        PayoutState storage p = _plan(a);
        require(p.attestationId == attestationId, "not the governing attestation");
        require(!a.revoked, "attestation revoked");
        require(p.status == PayoutStatus.Active, "not Active");
        require(block.timestamp >= p.maturityAt, "not matured");

        uint256 amount = p.held;
        p.paid += amount;
        p.held = 0;
        p.status = PayoutStatus.Closed;

        if (amount > 0) IERC20Metadata(asset).safeTransfer(p.payee, amount);
        emit HoldbackReleased(a.subjectId, a.cycleId, amount);
    }

    function dispute(uint256 attestationId, bytes32 reasonHash) external override onlyRole(DISPUTER_ROLE) {
        IAttestationRegistry.Attestation memory a = _attestation(attestationId);
        PayoutState storage p = _plan(a);
        require(p.attestationId == attestationId, "not the governing attestation");
        require(p.status == PayoutStatus.Active, "not Active");
        p.status = PayoutStatus.Disputed;
        emit Disputed(a.subjectId, a.cycleId, reasonHash);
    }

    function resolveDispute(uint256 attestationId, bool releaseFunds)
        external
        override
        nonReentrant
        onlyRole(RESOLVER_ROLE)
    {
        IAttestationRegistry.Attestation memory a = _attestation(attestationId);
        PayoutState storage p = _plan(a);
        require(p.attestationId == attestationId, "not the governing attestation");
        require(p.status == PayoutStatus.Disputed, "not Disputed");

        uint256 amount = p.held;
        p.held = 0;
        p.status = PayoutStatus.Closed;
        if (releaseFunds) {
            p.paid += amount;
            if (amount > 0) IERC20Metadata(asset).safeTransfer(p.payee, amount);
        } else {
            p.forfeited += amount;
            cycleBalance[a.cycleId] += amount;
        }
        emit DisputeResolved(a.subjectId, a.cycleId, releaseFunds);
    }

    /// @dev spec/ENGINE.md `revision`. Overpaid is recorded, never clawed back by force.
    function applyRevision(uint256 oldAttestationId, uint256 newAttestationId)
        external
        override
        onlyRole(PAYOUT_ROLE)
    {
        IAttestationRegistry.Attestation memory nw = _attestation(newAttestationId);
        PayoutState storage p = _plan(nw);
        require(p.attestationId == oldAttestationId, "old is not the governing attestation");
        IAttestationRegistry.Attestation memory old = _attestation(oldAttestationId);
        require(old.subjectId == nw.subjectId && old.cycleId == nw.cycleId, "subject/cycle mismatch");
        require(!nw.revoked, "new attestation revoked");
        require(nw.supersedes == oldAttestationId, "new does not supersede old");

        uint256 newEnt = (p.targetBonus * nw.multiplierBps) / BPS;
        uint256 heldRemaining = _max0(newEnt, p.paid);
        uint256 overpaid = _max0(p.paid, newEnt);
        uint256 forfeited = _max0(p.held, heldRemaining);
        uint256 extraOwed = _max0(heldRemaining, p.held);

        uint256 bal = cycleBalance[nw.cycleId];
        require(extraOwed <= bal, "insufficient cycle balance for extraOwed");
        cycleBalance[nw.cycleId] = bal + forfeited - extraOwed;

        bool wasClosed = p.status == PayoutStatus.Closed;
        p.held = heldRemaining;
        p.entitlement = newEnt;
        p.attestationId = newAttestationId;
        p.forfeited += forfeited;
        p.overpaid = overpaid;
        if (wasClosed && heldRemaining > 0) p.status = PayoutStatus.Active;

        emit RevisionApplied(
            nw.subjectId, nw.cycleId, oldAttestationId, newAttestationId, heldRemaining, forfeited, extraOwed, overpaid
        );
    }

    // ---------------------------------------------------------------- views

    function getPayout(bytes32 subjectId, uint64 cycleId) external view override returns (PayoutState memory) {
        return _payouts[subjectId][cycleId];
    }

    function maturitySecondsOf(bytes32 subjectId, uint64 cycleId) external view returns (uint64) {
        return _maturitySeconds[subjectId][cycleId];
    }

    function hasRole(bytes32 role, address account) public view override(AccessControl, IBonusVault) returns (bool) {
        return super.hasRole(role, account);
    }

    // ---------------------------------------------------------------- internals

    function _attestation(uint256 id) private view returns (IAttestationRegistry.Attestation memory) {
        return IAttestationRegistry(registry).getAttestation(id);
    }

    function _plan(IAttestationRegistry.Attestation memory a) private view returns (PayoutState storage p)
    {
        p = _payouts[a.subjectId][a.cycleId];
        require(p.status != PayoutStatus.None, "plan not registered");
    }

    /// @dev max(0, x - y) without underflow.
    function _max0(uint256 x, uint256 y) private pure returns (uint256) {
        return x > y ? x - y : 0;
    }
}
