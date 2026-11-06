// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "./utils/Test.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {BonusVault} from "../src/BonusVault.sol";
import {IBonusVault} from "../src/interfaces/IBonusVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract Token18 {
    uint8 public constant decimals = 18;
}

/// Test ids c05-c14 mirror AGENT_B.md 2.3. Amounts come from spec/vectors/vectors.json
/// (payout_split_cases, revision_cases) and spec/fixtures/seed-scenario.json (s3 revision for emp_dev_a).
contract BonusVaultTest is Test {
    AttestationRegistry reg;
    BonusVault vault;
    MockUSDC usdc;

    address anchor = address(0xA11CE); // ANCHOR + ATTESTER (backend anchor key)
    address payer = address(0xB0B); // PLANNER + PAYOUT + DISPUTER + RESOLVER (backend payout key)
    address payee = address(0xE1);
    address stranger = address(0xBAD);

    bytes32 constant SUBJ = keccak256("emp_dev_a@cyc_2026h2");
    uint64 constant CYCLE = 1;
    uint256 constant TARGET = 5_000_000_000; // 5,000 USDC
    uint16 constant HOLDBACK = 2000;
    uint64 constant MATURITY = 90 days;
    uint256 constant FUND = 100_000_000_000; // 100,000 USDC

    function setUp() public {
        reg = new AttestationRegistry();
        usdc = new MockUSDC();
        vault = new BonusVault(address(usdc), address(reg));

        reg.grantRole(reg.ANCHOR_ROLE(), anchor);
        reg.grantRole(reg.ATTESTER_ROLE(), anchor);
        vault.grantRole(vault.PLANNER_ROLE(), payer);
        vault.grantRole(vault.PAYOUT_ROLE(), payer);
        vault.grantRole(vault.DISPUTER_ROLE(), payer);
        vault.grantRole(vault.RESOLVER_ROLE(), payer);

        usdc.mint(address(this), 10 * FUND);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundCycle(CYCLE, FUND);
    }

    // ---------------------------------------------------------------- helpers

    function _attest(uint32 version, uint16 mult, uint256 supersedes) internal returns (uint256 id) {
        vm.prank(anchor);
        id = reg.attestScore(SUBJ, CYCLE, version, keccak256("s"), keccak256("r"), keccak256("f"), keccak256("a"), mult, supersedes);
    }

    function _register(uint256 target, uint16 holdback) internal {
        vm.prank(payer);
        vault.registerPlan(SUBJ, CYCLE, payee, target, holdback, MATURITY);
    }

    function _release(uint256 id) internal {
        vm.prank(payer);
        vault.release(id);
    }

    function _payout() internal view returns (IBonusVault.PayoutState memory) {
        return vault.getPayout(SUBJ, CYCLE);
    }

    /// v1 at 100%: pays 4,000 immediately and holds 1,000.
    function _releasedV1() internal returns (uint256 v1) {
        _register(TARGET, HOLDBACK);
        v1 = _attest(1, 10000, 0);
        _release(v1);
    }

    function _checkInvariant() internal view {
        IBonusVault.PayoutState memory p = _payout();
        uint256 reserved = vault.cycleBalance(CYCLE) + vault.cycleBalance(2) + p.held;
        assertTrue(usdc.balanceOf(address(vault)) >= reserved, "c13 invariant: balance >= cycleBalance + held");
        assertEq(usdc.balanceOf(payee), p.paid, "payee received exactly `paid`");
    }

    // ---------------------------------------------------------------- c05

    function test_c05_payoutSplit() public {
        _releasedV1();
        IBonusVault.PayoutState memory p = _payout();
        assertEq(p.entitlement, 5_000_000_000, "entitlement");
        assertEq(p.paid, 4_000_000_000, "immediate");
        assertEq(p.held, 1_000_000_000, "held");
        assertEq(usdc.balanceOf(payee), 4_000_000_000, "payee balance");
        assertEq(vault.cycleBalance(CYCLE), FUND - 5_000_000_000, "entitlement reserved from cycle");
        assertTrue(p.status == IBonusVault.PayoutStatus.Active, "Active");
        _checkInvariant();
    }

    // ---------------------------------------------------------------- c06

    function _revise(uint16 newMult)
        internal
        returns (uint256 forfeited, uint256 extraOwed, IBonusVault.PayoutState memory p)
    {
        uint256 v1 = _releasedV1();
        uint256 balBefore = vault.cycleBalance(CYCLE);
        uint256 v2 = _attest(2, newMult, v1);
        vm.prank(payer);
        vault.applyRevision(v1, v2);
        p = _payout();
        uint256 balAfter = vault.cycleBalance(CYCLE);
        forfeited = balAfter > balBefore ? balAfter - balBefore : 0;
        extraOwed = balBefore > balAfter ? balBefore - balAfter : 0;
        assertEq(p.attestationId, v2, "governing attestation is v2");
        _checkInvariant();
    }

    function test_c06_revision_downwardBig() public {
        (uint256 forfeited, uint256 extraOwed, IBonusVault.PayoutState memory p) = _revise(7500);
        assertEq(p.entitlement, 3_750_000_000, "new_entitlement");
        assertEq(p.held, 0, "held_remaining");
        assertEq(p.overpaid, 250_000_000, "overpaid");
        assertEq(forfeited, 1_000_000_000, "forfeited");
        assertEq(p.forfeited, 1_000_000_000, "forfeited recorded");
        assertEq(extraOwed, 0, "extra_owed");
    }

    function test_c06_revision_downwardSmall() public {
        (uint256 forfeited, uint256 extraOwed, IBonusVault.PayoutState memory p) = _revise(9500);
        assertEq(p.entitlement, 4_750_000_000, "new_entitlement");
        assertEq(p.held, 750_000_000, "held_remaining");
        assertEq(p.overpaid, 0, "overpaid");
        assertEq(forfeited, 250_000_000, "forfeited");
        assertEq(extraOwed, 0, "extra_owed");
    }

    function test_c06_revision_upward() public {
        (uint256 forfeited, uint256 extraOwed, IBonusVault.PayoutState memory p) = _revise(12000);
        assertEq(p.entitlement, 6_000_000_000, "new_entitlement");
        assertEq(p.held, 2_000_000_000, "held_remaining");
        assertEq(p.overpaid, 0, "overpaid");
        assertEq(forfeited, 0, "forfeited");
        assertEq(extraOwed, 1_000_000_000, "extra_owed");
    }

    // ---------------------------------------------------------------- c07

    function test_c07_demoRevertRevision() public {
        // seed-scenario s3: PR #101 reverted -> score 9071 -> 8621 bps, multiplier 10000 -> 9052.
        (uint256 forfeited,, IBonusVault.PayoutState memory p) = _revise(9052);
        assertEq(p.entitlement, 4_526_000_000, "new_entitlement");
        assertEq(forfeited, 474_000_000, "forfeited");
        assertEq(p.held, 526_000_000, "held");
        assertEq(p.overpaid, 0, "overpaid");
    }

    // ---------------------------------------------------------------- c08

    function test_c08_releaseRevertsForRevokedAttestation() public {
        _register(TARGET, HOLDBACK);
        uint256 v1 = _attest(1, 10000, 0);
        vm.prank(anchor);
        reg.revoke(v1, keccak256("fraud"));
        vm.prank(payer);
        vm.expectRevert(bytes("attestation revoked"));
        vault.release(v1);
    }

    function test_c08_releaseRevertsForSupersededAttestation() public {
        _register(TARGET, HOLDBACK);
        uint256 v1 = _attest(1, 10000, 0);
        _attest(2, 9000, v1);
        vm.prank(payer);
        vm.expectRevert(bytes("attestation revoked"));
        vault.release(v1);
    }

    function test_c08_releaseWithoutPlanReverts() public {
        uint256 v1 = _attest(1, 10000, 0);
        vm.prank(payer);
        vm.expectRevert(bytes("plan not registered"));
        vault.release(v1);
    }

    // ---------------------------------------------------------------- c09

    function test_c09_holdbackMaturityAndDoubleRelease() public {
        uint256 v1 = _releasedV1();
        uint256 releasedAt = block.timestamp;

        vm.startPrank(payer);
        vm.expectRevert(bytes("not in Registered state"));
        vault.release(v1);

        vm.expectRevert(bytes("not matured"));
        vault.releaseHoldback(v1);

        vm.warp(releasedAt + MATURITY);
        vault.releaseHoldback(v1);
        vm.stopPrank();

        IBonusVault.PayoutState memory p = _payout();
        assertEq(p.paid, 5_000_000_000, "full entitlement paid");
        assertEq(p.held, 0, "nothing held");
        assertTrue(p.status == IBonusVault.PayoutStatus.Closed, "Closed");
        assertEq(usdc.balanceOf(payee), 5_000_000_000, "payee balance");

        vm.prank(payer);
        vm.expectRevert(bytes("not Active"));
        vault.releaseHoldback(v1);
        _checkInvariant();
    }

    function test_releaseWithZeroMultiplierClosesWithoutPaying() public {
        _register(TARGET, HOLDBACK);
        uint256 v1 = _attest(1, 0, 0);
        _release(v1);
        IBonusVault.PayoutState memory p = _payout();
        assertTrue(p.status == IBonusVault.PayoutStatus.Closed, "Closed");
        assertEq(p.paid, 0, "nothing paid");
        assertEq(vault.cycleBalance(CYCLE), FUND, "nothing reserved");
    }

    // ---------------------------------------------------------------- c10

    function test_c10_disputeFreezesThenResolveReleases() public {
        uint256 v1 = _releasedV1();
        vm.startPrank(payer);
        vault.dispute(v1, keccak256("client complaint"));
        vm.warp(block.timestamp + MATURITY);
        vm.expectRevert(bytes("not Active"));
        vault.releaseHoldback(v1);

        vault.resolveDispute(v1, true);
        vm.stopPrank();
        IBonusVault.PayoutState memory p = _payout();
        assertEq(p.paid, 5_000_000_000, "held paid on resolve(true)");
        assertEq(p.held, 0, "nothing held");
        assertTrue(p.status == IBonusVault.PayoutStatus.Closed, "Closed");
        _checkInvariant();
    }

    function test_c10_resolveFalseForfeitsToCycle() public {
        uint256 v1 = _releasedV1();
        uint256 balBefore = vault.cycleBalance(CYCLE);
        vm.startPrank(payer);
        vault.dispute(v1, keccak256("client complaint"));
        vault.resolveDispute(v1, false);
        vm.stopPrank();
        IBonusVault.PayoutState memory p = _payout();
        assertEq(p.paid, 4_000_000_000, "only immediate paid");
        assertEq(p.forfeited, 1_000_000_000, "held forfeited");
        assertEq(vault.cycleBalance(CYCLE), balBefore + 1_000_000_000, "returned to cycle pool");
        _checkInvariant();
    }

    function test_c10_disputeRequiresActiveAndGoverning() public {
        uint256 v1 = _releasedV1();
        vm.startPrank(payer);
        vm.expectRevert(bytes("not Disputed"));
        vault.resolveDispute(v1, true);
        vault.dispute(v1, 0);
        vm.expectRevert(bytes("not Active"));
        vault.dispute(v1, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- c11

    function test_c11_roleChecksOnEveryRestrictedFunction() public {
        uint256 v1 = _releasedV1();
        bytes memory missing = bytes("AccessControl: missing role");
        vm.startPrank(stranger);
        vm.expectRevert(missing);
        vault.registerPlan(keccak256("x"), CYCLE, payee, TARGET, HOLDBACK, MATURITY);
        vm.expectRevert(missing);
        vault.release(v1);
        vm.expectRevert(missing);
        vault.releaseHoldback(v1);
        vm.expectRevert(missing);
        vault.dispute(v1, 0);
        vm.expectRevert(missing);
        vault.resolveDispute(v1, true);
        vm.expectRevert(missing);
        vault.applyRevision(v1, v1);
        vm.expectRevert(missing);
        vault.grantRole(keccak256("PAYOUT_ROLE"), stranger);
        vm.stopPrank();
    }

    function test_c11_rolesAreSeparated() public {
        // The anchor key cannot move money; the payout key cannot attest.
        uint256 v1 = _releasedV1();
        vm.prank(anchor);
        vm.expectRevert(bytes("AccessControl: missing role"));
        vault.releaseHoldback(v1);
        vm.prank(payer);
        vm.expectRevert(bytes("AccessControl: missing role"));
        reg.attestScore(SUBJ, CYCLE, 2, 0, 0, 0, 0, 10000, v1);
    }

    function test_c11_roleConstantsMatchSpec() public view {
        assertEq(vault.PLANNER_ROLE(), keccak256("PLANNER_ROLE"), "planner");
        assertEq(vault.PAYOUT_ROLE(), keccak256("PAYOUT_ROLE"), "payout");
        assertEq(vault.DISPUTER_ROLE(), keccak256("DISPUTER_ROLE"), "disputer");
        assertEq(vault.RESOLVER_ROLE(), keccak256("RESOLVER_ROLE"), "resolver");
        assertEq(vault.asset(), address(usdc), "asset");
        assertEq(vault.registry(), address(reg), "registry");
    }

    // ---------------------------------------------------------------- c12

    function test_c12_constructorRejectsNon6Decimals() public {
        Token18 t = new Token18();
        vm.expectRevert(bytes("asset must have 6 decimals"));
        new BonusVault(address(t), address(reg));
    }

    // ---------------------------------------------------------------- c13

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }

    /// Fuzzed full lifecycle: release -> optional dispute/resolve -> optional revision -> optional holdback.
    function testFuzz_c13_invariantHoldsThroughLifecycle(
        uint256 target,
        uint16 holdback,
        uint16 mult1,
        uint16 mult2,
        uint8 path
    ) public {
        target = _bound(target, 0, 20_000_000_000);
        holdback = uint16(_bound(holdback, 0, 10000));
        mult1 = uint16(_bound(mult1, 0, 30000));
        mult2 = uint16(_bound(mult2, 0, 30000));

        vm.prank(payer);
        vault.registerPlan(SUBJ, CYCLE, payee, target, holdback, MATURITY);
        uint256 v1 = _attest(1, mult1, 0);
        _release(v1);
        _checkInvariant();

        IBonusVault.PayoutState memory p = _payout();
        bool active = p.status == IBonusVault.PayoutStatus.Active;

        if (path % 4 == 1 && active) {
            vm.startPrank(payer);
            vault.dispute(v1, 0);
            vault.resolveDispute(v1, path % 8 < 4);
            vm.stopPrank();
            _checkInvariant();
        }

        if (path % 3 != 0) {
            uint256 v2 = _attest(2, mult2, v1);
            vm.prank(payer);
            vault.applyRevision(v1, v2);
            _checkInvariant();
            p = _payout();
            uint256 newEnt = (target * mult2) / 10000;
            assertEq(p.entitlement, newEnt, "entitlement follows v2");
            assertEq(p.held, newEnt > p.paid ? newEnt - p.paid : 0, "held_remaining");
            assertEq(p.overpaid, p.paid > newEnt ? p.paid - newEnt : 0, "overpaid");
            v1 = v2;
        }

        p = _payout();
        if (p.status == IBonusVault.PayoutStatus.Active) {
            vm.warp(block.timestamp + MATURITY);
            vm.prank(payer);
            vault.releaseHoldback(v1);
            _checkInvariant();
        }
    }

    // ---------------------------------------------------------------- c14

    function test_c14_upwardRevisionNeedsFunds() public {
        // A second cycle funded with exactly the v1 entitlement.
        uint64 c2 = 2;
        vault.fundCycle(c2, TARGET);
        vm.prank(payer);
        vault.registerPlan(SUBJ, c2, payee, TARGET, HOLDBACK, MATURITY);
        vm.prank(anchor);
        uint256 v1 = reg.attestScore(SUBJ, c2, 1, 0, 0, 0, 0, 10000, 0);
        vm.prank(payer);
        vault.release(v1);
        assertEq(vault.cycleBalance(c2), 0, "cycle drained");

        vm.prank(anchor);
        uint256 v2 = reg.attestScore(SUBJ, c2, 2, 0, 0, 0, 0, 12000, v1);
        vm.prank(payer);
        vm.expectRevert(bytes("insufficient cycle balance for extraOwed"));
        vault.applyRevision(v1, v2);

        vault.fundCycle(c2, 1_000_000_000);
        vm.prank(payer);
        vault.applyRevision(v1, v2);
        IBonusVault.PayoutState memory p = vault.getPayout(SUBJ, c2);
        assertEq(p.held, 2_000_000_000, "held grows by extraOwed");
        assertEq(vault.cycleBalance(c2), 0, "extraOwed taken from cycle");
    }

    // ---------------------------------------------------------------- revision edge cases (match MockChain)

    function test_revisionReopensClosedPayoutWhenMoneyIsOwed() public {
        uint256 v1 = _releasedV1();
        vm.warp(block.timestamp + MATURITY);
        vm.prank(payer);
        vault.releaseHoldback(v1);
        uint256 v2 = _attest(2, 12000, v1);
        vm.prank(payer);
        vault.applyRevision(v1, v2);
        IBonusVault.PayoutState memory p = _payout();
        assertTrue(p.status == IBonusVault.PayoutStatus.Active, "reopened");
        assertEq(p.held, 1_000_000_000, "owes the difference");
        _checkInvariant();
    }

    function test_revisionRejectsNonSupersedingOrStale() public {
        uint256 v1 = _releasedV1();
        uint256 v2 = _attest(2, 9000, v1);
        uint256 v3 = _attest(3, 8000, v2);
        vm.startPrank(payer);
        vm.expectRevert(bytes("new does not supersede old"));
        vault.applyRevision(v1, v3);
        vm.expectRevert(bytes("old is not the governing attestation"));
        vault.applyRevision(v2, v3);
        vm.expectRevert(bytes("new attestation revoked"));
        vault.applyRevision(v1, v2); // v2 was superseded by v3
        vm.stopPrank();
    }

    function test_registerPlanValidation() public {
        _register(TARGET, HOLDBACK);
        vm.startPrank(payer);
        vm.expectRevert(bytes("already registered"));
        vault.registerPlan(SUBJ, CYCLE, payee, TARGET, HOLDBACK, MATURITY);
        vm.expectRevert(bytes("zero payee"));
        vault.registerPlan(keccak256("y"), CYCLE, address(0), TARGET, HOLDBACK, MATURITY);
        vm.expectRevert(bytes("bad holdback"));
        vault.registerPlan(keccak256("y"), CYCLE, payee, TARGET, 10001, MATURITY);
        vm.stopPrank();
    }

    function test_releaseRevertsWhenCycleUnderfunded() public {
        vm.prank(payer);
        vault.registerPlan(SUBJ, 3, payee, TARGET, HOLDBACK, MATURITY);
        vm.prank(anchor);
        uint256 v1 = reg.attestScore(SUBJ, 3, 1, 0, 0, 0, 0, 10000, 0);
        vm.prank(payer);
        vm.expectRevert(bytes("insufficient cycle balance"));
        vault.release(v1);
    }
}
