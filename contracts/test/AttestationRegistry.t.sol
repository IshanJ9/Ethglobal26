// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "./utils/Test.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IAttestationRegistry} from "../src/interfaces/IAttestationRegistry.sol";

/// Test ids c01-c04 mirror AGENT_B.md 2.3.
contract AttestationRegistryTest is Test {
    AttestationRegistry reg;
    address anchor = address(0xA11CE);
    address stranger = address(0xBAD);
    bytes32 constant SUBJ = keccak256("subject-1");
    bytes32 constant SUBJ2 = keccak256("subject-2");

    function setUp() public {
        reg = new AttestationRegistry();
        reg.grantRole(reg.ANCHOR_ROLE(), anchor);
        reg.grantRole(reg.ATTESTER_ROLE(), anchor);
    }

    function _attest(bytes32 subj, uint64 cycle, uint32 version, uint16 mult, uint256 supersedes)
        internal
        returns (uint256)
    {
        vm.prank(anchor);
        return reg.attestScore(
            subj, cycle, version, keccak256("score"), keccak256("root"), keccak256("formula"), keccak256("approval"), mult, supersedes
        );
    }

    // c01
    function test_c01_onlyAnchorCanAnchor() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("AccessControl: missing role"));
        reg.anchorBatch(keccak256("r"), 1, 3);
    }

    function test_c01_anchorStoresRoot() public {
        vm.prank(anchor);
        reg.anchorBatch(keccak256("r"), 7, 3);
        assertEq(reg.batchRoot(7), keccak256("r"), "root stored");
    }

    function test_c01_duplicateBatchReverts() public {
        vm.startPrank(anchor);
        reg.anchorBatch(keccak256("r"), 1, 3);
        vm.expectRevert(bytes("batch exists"));
        reg.anchorBatch(keccak256("other"), 1, 3);
        vm.stopPrank();
    }

    function test_c01_zeroRootOrCountReverts() public {
        vm.startPrank(anchor);
        vm.expectRevert(bytes("zero root"));
        reg.anchorBatch(bytes32(0), 1, 3);
        vm.expectRevert(bytes("zero count"));
        reg.anchorBatch(keccak256("r"), 1, 0);
        vm.stopPrank();
    }

    // c02
    function test_c02_supersedeRevokesOldAndUpdatesLatest() public {
        uint256 v1 = _attest(SUBJ, 1, 1, 10000, 0);
        assertEq(v1, 1, "ids start at 1");
        assertEq(reg.latestAttestation(SUBJ, 1), v1, "latest v1");

        uint256 v2 = _attest(SUBJ, 1, 2, 9052, v1);
        assertEq(v2, 2, "v2 id");
        assertTrue(reg.getAttestation(v1).revoked, "v1 revoked");
        assertTrue(!reg.getAttestation(v2).revoked, "v2 live");
        assertEq(reg.getAttestation(v2).supersedes, v1, "v2 supersedes v1");
        assertEq(reg.latestAttestation(SUBJ, 1), v2, "latest v2");
    }

    // c03
    function test_c03_attestWithoutSupersedingReverts() public {
        _attest(SUBJ, 1, 1, 10000, 0);
        vm.prank(anchor);
        vm.expectRevert(bytes("must supersede"));
        reg.attestScore(SUBJ, 1, 2, 0, 0, 0, 0, 10000, 0);
    }

    function test_c03_otherCycleOrSubjectIsIndependent() public {
        _attest(SUBJ, 1, 1, 10000, 0);
        _attest(SUBJ, 2, 1, 10000, 0);
        _attest(SUBJ2, 1, 1, 10000, 0);
        assertEq(reg.attestationCount(), 3, "three independent attestations");
    }

    // c04
    function test_c04_supersedeWrongSubjectReverts() public {
        uint256 v1 = _attest(SUBJ, 1, 1, 10000, 0);
        vm.prank(anchor);
        vm.expectRevert(bytes("supersede subject/cycle mismatch"));
        reg.attestScore(SUBJ2, 1, 2, 0, 0, 0, 0, 10000, v1);
    }

    function test_c04_supersedeWrongCycleReverts() public {
        uint256 v1 = _attest(SUBJ, 1, 1, 10000, 0);
        vm.prank(anchor);
        vm.expectRevert(bytes("supersede subject/cycle mismatch"));
        reg.attestScore(SUBJ, 2, 2, 0, 0, 0, 0, 10000, v1);
    }

    function test_c04_supersedeLowerOrEqualVersionReverts() public {
        uint256 v1 = _attest(SUBJ, 1, 2, 10000, 0);
        vm.startPrank(anchor);
        vm.expectRevert(bytes("version must increase"));
        reg.attestScore(SUBJ, 1, 2, 0, 0, 0, 0, 10000, v1);
        vm.expectRevert(bytes("version must increase"));
        reg.attestScore(SUBJ, 1, 1, 0, 0, 0, 0, 10000, v1);
        vm.stopPrank();
    }

    function test_c04_supersedeRevokedReverts() public {
        uint256 v1 = _attest(SUBJ, 1, 1, 10000, 0);
        _attest(SUBJ, 1, 2, 10000, v1);
        vm.prank(anchor);
        vm.expectRevert(bytes("superseded is revoked"));
        reg.attestScore(SUBJ, 1, 3, 0, 0, 0, 0, 10000, v1);
    }

    // input validation shared with the backend mock
    function test_attestInputValidation() public {
        vm.startPrank(anchor);
        vm.expectRevert(bytes("zero subject"));
        reg.attestScore(bytes32(0), 1, 1, 0, 0, 0, 0, 10000, 0);
        vm.expectRevert(bytes("bad version"));
        reg.attestScore(SUBJ, 1, 0, 0, 0, 0, 0, 10000, 0);
        vm.expectRevert(bytes("multiplier too high"));
        reg.attestScore(SUBJ, 1, 1, 0, 0, 0, 0, 30001, 0);
        vm.expectRevert(bytes("unknown attestation"));
        reg.attestScore(SUBJ, 1, 1, 0, 0, 0, 0, 10000, 99);
        vm.stopPrank();
    }

    function test_revokeClearsLatestAndAllowsFreshAttest() public {
        uint256 v1 = _attest(SUBJ, 1, 1, 10000, 0);
        vm.prank(anchor);
        reg.revoke(v1, keccak256("fraud"));
        assertEq(reg.latestAttestation(SUBJ, 1), 0, "latest cleared");
        _attest(SUBJ, 1, 2, 8000, 0); // allowed: nothing live to supersede
    }

    function test_roleChecksOnRegistry() public {
        vm.startPrank(stranger);
        vm.expectRevert(bytes("AccessControl: missing role"));
        reg.attestScore(SUBJ, 1, 1, 0, 0, 0, 0, 10000, 0);
        vm.expectRevert(bytes("AccessControl: missing role"));
        reg.revoke(1, 0);
        vm.expectRevert(bytes("AccessControl: missing role"));
        reg.grantRole(keccak256("ANCHOR_ROLE"), stranger);
        vm.stopPrank();
    }

    function test_roleConstantsMatchSpec() public view {
        assertEq(reg.ANCHOR_ROLE(), keccak256("ANCHOR_ROLE"), "anchor role");
        assertEq(reg.ATTESTER_ROLE(), keccak256("ATTESTER_ROLE"), "attester role");
    }
}
