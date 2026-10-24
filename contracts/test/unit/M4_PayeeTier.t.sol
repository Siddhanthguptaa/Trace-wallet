// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M4Base, M4Lib} from "./M4_Base.sol";
import {M4Vectors} from "./M4_Vectors.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {AccountStorage} from "../../src/lib/AccountStorage.sol";
import {TypedData} from "../../src/lib/TypedData.sol";
import {
    Tier,
    Track,
    Reason,
    Session,
    Bucket,
    AssetLimit,
    PolicyInput,
    AssetInput,
    CallRuleInput,
    ArgRule,
    RuleOp,
    NATIVE,
    ANY_TARGET,
    TARGET_ARG,
    ERC1271_MAGIC
} from "../../src/lib/PolicyTypes.sol";

/// M4 (D3): attested payee tiers, escalate-only flags, the exploration track, tier re-derivation
/// in execution. Tests F24-F27, F31 (IDEA.md section 5) plus tier / attest / flag / explore units.
contract M4_PayeeTierTest is M4Base {
    // ================================================================ tiers

    function test_tier_noPayeeIsNone() public view {
        bytes memory cd = _agentCall(address(ticket), 0, abi.encodeWithSelector(BUY, uint256(7), address(acct)));
        (uint16 reason, Tier tier, Track track, uint48 until) = acct.policyCheck(agent, cd, _att(shop), "");
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.NONE));
        assertEq(uint8(track), uint8(Track.NORMAL));
        assertEq(until, _sessionUntil(), "attestation ignored without a payee");
    }

    function test_tier_listedIsProvenAndIgnoresAttestation() public view {
        bytes memory shortAtt = _attFor(
            ATTESTOR_PK, address(acct), block.chainid, address(grocery), 1, uint48(block.timestamp + 60), 1
        );
        (uint16 reason, Tier tier, Track track, uint48 until) = _check(address(grocery), 5e6, shortAtt);
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.PROVEN));
        assertEq(uint8(track), uint8(Track.NORMAL));
        assertEq(until, _sessionUntil(), "listed payee: attestation expiry not folded");
    }

    function test_tier_unprovenTakesExplorationTrack() public {
        (uint16 reason, Tier tier, Track track, uint48 until) = _check(attacker, 0.1e6, "");
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(uint8(track), uint8(Track.EXPLORE));
        assertEq(until, _sessionUntil());
        Vm.Log[] memory logs = _run(_one(_payOp(attacker, 0.1e6, "")));
        (bool found, Tier t, Track tr) = _decision(logs);
        assertTrue(found, "executed");
        assertEq(uint8(t), uint8(Tier.UNPROVEN));
        assertEq(uint8(tr), uint8(Track.EXPLORE));
        assertEq(usdc.balanceOf(attacker), 0.1e6);
    }

    function test_tier_reDerivedInExecution_epochBumpBlocks() public {
        // Validation sees a valid attestation (PROVEN, normal caps); the owner op ahead of it in the
        // same bundle bumps the epoch, so the execution re-check derives UNPROVEN and 5 USDC > explorePerTxCap.
        PackedUserOperation memory agentOp = _payOp(shop, 5e6, _att(shop));
        PackedUserOperation[] memory ops = _pair(_ownerAdminOp(abi.encodeCall(AgentAccountAdmin.bumpEpoch, ())), agentOp);
        Vm.Log[] memory logs = _run(ops);
        (bool found, bytes memory why) = _blockedWhy(logs);
        assertTrue(found, "PolicyBlocked");
        assertEq(why, _violation(Reason.EXPLORE_PER_TX));
        (, bool success,) = _opResult(logs, ep.getUserOpHash(agentOp));
        assertTrue(success, "breach lands as success=true + PolicyBlocked");
        assertEq(usdc.balanceOf(shop), 0, "nothing moved");
    }

    function test_tier_reDerivedInExecution_trackChanges() public {
        PackedUserOperation memory agentOp = _payOp(shop, 0.1e6, _att(shop));
        (, Tier vTier, Track vTrack,) = _check(shop, 0.1e6, _att(shop));
        assertEq(uint8(vTier), uint8(Tier.PROVEN));
        assertEq(uint8(vTrack), uint8(Track.NORMAL));
        Vm.Log[] memory logs = _run(_pair(_ownerAdminOp(abi.encodeCall(AgentAccountAdmin.bumpEpoch, ())), agentOp));
        (bool found, Tier t, Track tr) = _decision(logs);
        assertTrue(found);
        assertEq(uint8(t), uint8(Tier.UNPROVEN), "tier re-derived from the same bytes");
        assertEq(uint8(tr), uint8(Track.EXPLORE), "charged to the exploration track");
        assertEq(usdc.balanceOf(shop), 0.1e6);
    }

    function test_tier_reDerivedInExecution_attestorRotatedBlocks() public {
        PackedUserOperation memory agentOp = _payOp(shop, 5e6, _att(shop));
        bytes memory rotate = abi.encodeCall(AgentAccountAdmin.setAttestor, (vm.addr(ATTESTOR2_PK)));
        Vm.Log[] memory logs = _run(_pair(_ownerAdminOp(rotate), agentOp));
        (bool found, bytes memory why) = _blockedWhy(logs);
        assertTrue(found);
        assertEq(why, _violation(Reason.EXPLORE_PER_TX));
        assertEq(usdc.balanceOf(shop), 0);
    }

    // ================================================================ attestations

    function test_attest_upgradesNewShopToProven() public {
        bytes memory a = _att(shop);
        (uint16 reason, Tier tier, Track track, uint48 until) = _check(shop, 5e6, a);
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.PROVEN));
        assertEq(uint8(track), uint8(Track.NORMAL));
        assertEq(until, _until(), "attestation validUntil folded");
        Vm.Log[] memory logs = _run(_one(_payOp(shop, 5e6, a)));
        (bool found, Tier t, Track tr) = _decision(logs);
        assertTrue(found);
        assertEq(uint8(t), uint8(Tier.PROVEN));
        assertEq(uint8(tr), uint8(Track.NORMAL));
        assertEq(usdc.balanceOf(shop), 5e6, "legit new shop paid with 0 owner approvals");
    }

    function test_attest_wrongRecipientIsUnproven() public view {
        (uint16 reason, Tier tier,,) = _check(attacker, 5e6, _att(shop));
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(reason, Reason.EXPLORE_PER_TX);
    }

    function test_attest_onlyTierProvenUpgrades() public view {
        for (uint8 t; t < 6; ++t) {
            if (t == uint8(Tier.PROVEN)) continue;
            bytes memory a = _attFor(ATTESTOR_PK, address(acct), block.chainid, shop, t, _until(), 1);
            (uint16 reason, Tier tier,, uint48 until) = _check(shop, 5e6, a);
            assertEq(uint8(tier), uint8(Tier.UNPROVEN), "signed non-PROVEN tier never upgrades");
            assertEq(reason, Reason.EXPLORE_PER_TX);
            assertEq(until, _sessionUntil());
        }
    }

    function test_attest_noAttestorSetIsUnproven() public {
        vm.prank(owner);
        admin.setAttestor(address(0));
        (, Tier tier,,) = _check(shop, 0.1e6, _att(shop));
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
    }

    function test_attest_malformedIsUnprovenNeverReverts() public view {
        bytes memory good = _att(shop);
        bytes[] memory bad = new bytes[](12);
        bad[0] = "";
        bad[1] = hex"00";
        bad[2] = _resize(good, 255);
        bad[3] = _resize(good, 257);
        (uint8 v, bytes32 r, bytes32 s) = _vrs(good);
        bad[4] = abi.encode(uint8(1), _until(), uint64(1), abi.encodePacked(r, s)); // 64-byte sig
        bad[5] = _setWord(good, 3, 0xa0); // wrong offset
        bad[6] = _setWord(good, 4, 64); // wrong sig length
        bad[7] = _setWord(good, 0, 0x101); // dirty tier word
        bad[8] = _setWord(good, 1, uint256(type(uint48).max) + 1); // validUntil beyond uint48
        // high-s twin of the valid signature (same signer under ecrecover, refused by tryRecover)
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bad[9] = abi.encode(uint8(1), _until(), uint64(1), abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27)));
        bad[10] = abi.encodePacked(keccak256("a"), keccak256("b"), keccak256("c"), keccak256("d"), keccak256("e"), keccak256("f"), keccak256("g"), keccak256("h"));
        // signature over the bare struct hash (no EIP-712 domain)
        bytes32 bare = TypedData.hashScoreAttestation(TypedData.ScoreAttestation(shop, 1, _until(), 1));
        bad[11] = abi.encode(uint8(1), _until(), uint64(1), _sign65(ATTESTOR_PK, bare));
        for (uint256 i; i < bad.length; ++i) {
            (uint16 reason, Tier tier, Track track, uint48 until) = _check(shop, 5e6, bad[i]);
            assertEq(uint8(tier), uint8(Tier.UNPROVEN), "malformed = unproven");
            assertEq(uint8(track), uint8(Track.EXPLORE));
            assertEq(reason, Reason.EXPLORE_PER_TX, "unproven caps apply");
            assertEq(until, _sessionUntil(), "malformed expiry never folded");
        }
        (, Tier okTier,,) = _check(shop, 5e6, good);
        assertEq(uint8(okTier), uint8(Tier.PROVEN), "control");
    }

    function test_attest_fuzzJunkNeverProven(bytes memory junk) public view {
        (uint16 reason, Tier tier,, uint48 until) = _check(shop, 0.1e6, junk);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(reason, Reason.OK);
        assertEq(until, _sessionUntil());
    }

    /// I9 as a fuzz property: PROVEN iff tier 1, nonzero validUntil, current epoch, this chain,
    /// this wallet, this recipient, signed by the attestor.
    function test_attest_fuzzFieldsProvenOnlyWhenExact(
        uint8 tier,
        uint48 until,
        uint64 epoch,
        uint256 chainId,
        address wallet,
        address recipient,
        uint8 mix
    ) public view {
        if (mix % 2 == 0) wallet = address(acct);
        if (mix % 3 == 0) recipient = shop;
        if (mix % 5 != 0) chainId = block.chainid;
        if (mix % 7 != 0) epoch = 1;
        if (mix % 11 != 0) tier = 1;
        bytes memory a = _attFor(ATTESTOR_PK, wallet, chainId, recipient, tier, until, epoch);
        (, Tier t,, uint48 vu) = _check(shop, 0.1e6, a);
        bool exact = tier == 1 && until != 0 && epoch == 1 && chainId == block.chainid && wallet == address(acct)
            && recipient == shop;
        assertEq(t == Tier.PROVEN, exact);
        if (exact) assertEq(vu, until < _sessionUntil() ? until : _sessionUntil());
        else assertEq(vu, _sessionUntil());
    }

    // ================================================================ exploration track

    function test_explore_perTxCapDecodedInValidation() public {
        (uint16 reason, Tier tier,,) = _check(attacker, EXPLORE_PER_TX, "");
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        (reason,,,) = _check(attacker, EXPLORE_PER_TX + 1, "");
        assertEq(reason, Reason.EXPLORE_PER_TX);
        PackedUserOperation memory op = _payOp(attacker, EXPLORE_PER_TX + 1, "");
        assertEq(_reason(acct, op), Reason.EXPLORE_PER_TX);
        _expectAA24(op);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_explore_zeroCapDisablesExploration() public {
        vm.prank(owner);
        admin.setExplorePerTxCap(address(usdc), 0);
        (uint16 reason,,,) = _check(attacker, 1, "");
        assertEq(reason, Reason.EXPLORE_PER_TX, "R3 config: unknown payees need an owner approval");
        (, Tier tier,,) = _check(shop, 5e6, _att(shop));
        assertEq(uint8(tier), uint8(Tier.PROVEN), "attested payees still pass");
    }

    function test_explore_valueOnTokenCallCapped() public view {
        // native value riding on an unproven transfer faces explorePerTxCap[NATIVE] (0: no native cap)
        bytes memory cd = _agentCall(address(usdc), 1, _xfer(attacker, 0.1e6));
        (uint16 reason, Tier tier,,) = acct.policyCheck(agent, cd, "", "");
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(reason, Reason.EXPLORE_PER_TX);
    }

    function test_explore_nativePayee() public {
        vm.startPrank(owner);
        admin.setGlobalCap(NATIVE, 0.01 ether, 0.01 ether); // explorePerTxCap[NATIVE] = 0.0002 ether
        PolicyInput memory p = _demoPolicy();
        p.assets = new AssetInput[](1);
        p.assets[0] = AssetInput(NATIVE, 0.005 ether, 0.01 ether, 0.01 ether);
        ArgRule[] memory r = new ArgRule[](1);
        r[0] = ArgRule(TARGET_ARG, RuleOp.PAYEE, 0);
        p.calls = new CallRuleInput[](1);
        p.calls[0] = CallRuleInput(ANY_TARGET, bytes4(0), r);
        admin.setPolicy(agent2, p);
        vm.stopPrank();
        (uint16 reason, Tier tier, Track track,) = acct.policyCheck(agent2, _agentCall(attacker, 0.0002 ether, ""), "", "");
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(uint8(track), uint8(Track.EXPLORE));
        (reason,,,) = acct.policyCheck(agent2, _agentCall(attacker, 0.0002 ether + 1, ""), "", "");
        assertEq(reason, Reason.EXPLORE_PER_TX);
        bytes memory a = _attFor(ATTESTOR_PK, address(acct), block.chainid, attacker, 1, _until(), 1);
        (reason, tier,,) = acct.policyCheck(agent2, _agentCall(attacker, 0.004 ether, ""), a, "");
        assertEq(uint8(tier), uint8(Tier.PROVEN), "attested native payee");
        assertEq(reason, Reason.OK);
        uint256 before = attacker.balance;
        assertTrue(_handle(_agentOp(acct, AGENT2_PK, attacker, 0.0001 ether, "")));
        assertEq(attacker.balance - before, 0.0001 ether);
    }

    // ================================================================ flags (escalate-only)

    function test_flag_attestorFlagsAndFlagBeatsAttestation() public {
        vm.prank(attestorAddr);
        admin.flag(shop);
        assertTrue(admin.isFlagged(shop));
        (uint16 reason, Tier tier,,) = _check(shop, 0.1e6, _att(shop));
        assertEq(uint8(tier), uint8(Tier.FLAGGED));
        assertEq(reason, Reason.FLAGGED);
        _expectAA24(_payOp(shop, 0.1e6, _att(shop)));
    }

    function test_flag_listedPayeeFlaggedIsRefused() public {
        vm.prank(attestorAddr);
        admin.flag(address(grocery));
        (uint16 reason, Tier tier,,) = _check(address(grocery), 1e6, "");
        assertEq(uint8(tier), uint8(Tier.FLAGGED));
        assertEq(reason, Reason.FLAGGED);
    }

    function test_flag_onlyOwnerClears() public {
        vm.prank(attestorAddr);
        admin.flag(shop);
        vm.prank(attestorAddr);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        admin.unflag(shop);
        vm.prank(stranger);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        admin.unflag(shop);
        assertTrue(admin.isFlagged(shop));
        vm.prank(owner);
        admin.unflag(shop);
        assertFalse(admin.isFlagged(shop));
        (, Tier tier,,) = _check(shop, 0.1e6, _att(shop));
        assertEq(uint8(tier), uint8(Tier.PROVEN));
    }

    function test_flag_strangerAndAgentCannotFlag() public {
        vm.prank(stranger);
        vm.expectRevert(AccountCommon.NotOwnerOrAttestor.selector);
        admin.flag(shop);
        vm.prank(agent);
        vm.expectRevert(AccountCommon.NotOwnerOrAttestor.selector);
        admin.flag(shop);
        vm.prank(owner);
        admin.setAttestor(address(0));
        vm.prank(address(0));
        vm.expectRevert(AccountCommon.NotOwnerOrAttestor.selector);
        admin.flag(shop);
    }

    function test_flag_betweenValidationAndExecutionBlocks() public {
        PackedUserOperation memory agentOp = _payOp(shop, 5e6, _att(shop));
        Vm.Log[] memory logs = _run(_pair(_ownerAdminOp(abi.encodeCall(AgentAccountAdmin.flag, (shop))), agentOp));
        (bool found, bytes memory why) = _blockedWhy(logs);
        assertTrue(found);
        assertEq(why, _violation(Reason.FLAGGED));
        assertEq(usdc.balanceOf(shop), 0);
    }

    /// I10 (unit form): the attestor can flag and nothing else.
    function test_flag_attestorCanOnlyFlag() public {
        address[] memory watch = new address[](4);
        (watch[0], watch[1], watch[2], watch[3]) = (shop, attacker, attestorAddr, address(grocery));
        bytes32 snap = M4Lib.snapshot(address(acct), address(usdc), agent, watch);
        bytes[] memory calls = M4Lib.ownerOnlyCalls(address(usdc), agent, attestorAddr, 1e6, _demoPolicy());
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(attestorAddr);
            (bool ok,) = address(acct).call(calls[i]);
            assertFalse(ok, "attestor refused on an owner-only entry point");
        }
        calls = M4Lib.moduleCalls(agent, attestorAddr);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(attestorAddr);
            (bool ok,) = address(acct).call(calls[i]);
            ok; // FRZ / REC semantics: judged by the snapshot below
        }
        vm.prank(attestorAddr);
        admin.flag(attacker);
        assertEq(M4Lib.snapshot(address(acct), address(usdc), agent, watch), snap, "only flags changed");
        assertTrue(admin.isFlagged(attacker));
        // no UserOp and no 1271 door for the attestor key
        PackedUserOperation memory op = _op(address(acct), _agentNonce(acct, agent), _payCd(attacker, 1));
        op = _signAgentWith(op, ATTESTOR_PK, "", "");
        assertEq(_reason(acct, op), Reason.NO_SESSION);
        bytes32 h = keccak256("anything");
        assertTrue(acct.isValidSignature(h, _sign65(ATTESTOR_PK, h)) != ERC1271_MAGIC);
    }

    // ================================================================ F24: never fail open

    function test_F24_missingAttestationIsUnproven() public view {
        (uint16 reason, Tier tier, Track track,) = _check(shop, 0.1e6, "");
        assertEq(reason, Reason.OK, "missing attestation is not a failure");
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(uint8(track), uint8(Track.EXPLORE));
        (reason,,,) = _check(shop, 5e6, "");
        assertEq(reason, Reason.EXPLORE_PER_TX, "and gets only the exploration caps");
    }

    function test_F24_invalidAttestationIsUnproven() public view {
        bytes memory forged = _attFor(STRANGER_PK, address(acct), block.chainid, shop, 1, _until(), 1);
        bytes memory byAgent = _attFor(AGENT_PK, address(acct), block.chainid, shop, 1, _until(), 1);
        bytes memory byOwner = _attFor(OWNER_PK, address(acct), block.chainid, shop, 1, _until(), 1);
        bytes[3] memory xs = [forged, byAgent, byOwner];
        for (uint256 i; i < 3; ++i) {
            (uint16 reason, Tier tier,,) = _check(shop, 5e6, xs[i]);
            assertEq(uint8(tier), uint8(Tier.UNPROVEN));
            assertEq(reason, Reason.EXPLORE_PER_TX);
        }
    }

    function test_F24_expiredAttestationNeverPays() public {
        bytes memory expired = _attFor(
            ATTESTOR_PK, address(acct), block.chainid, shop, 1, uint48(block.timestamp - 1), admin.attestEpoch()
        );
        // validation cannot read the clock: the expiry goes into validationData and the EntryPoint refuses
        (,,, uint48 until) = _check(shop, 5e6, expired);
        assertEq(until, block.timestamp - 1);
        _expectFailedOp(_payOp(shop, 5e6, expired), "AA22 expired or not due");
        assertEq(usdc.balanceOf(shop), 0);
        // dropped, the payee is simply unproven
        assertTrue(_handle(_payOp(shop, 0.1e6, "")));
        assertEq(usdc.balanceOf(shop), 0.1e6);
    }

    function test_F24_noAttestationRaisesAnyCap() public {
        AgentAccountAdmin ad = admin;
        bytes memory capsBefore = abi.encode(
            ad.globalBucket(address(usdc)).burst,
            ad.globalBucket(address(usdc)).ratePerDay,
            ad.exploreBucket(address(usdc)).burst,
            ad.exploreBucket(address(usdc)).ratePerDay,
            ad.explorePerTxCap(address(usdc)),
            ad.keyAsset(agent, address(usdc)).perTxCap
        );
        (uint16 reason, Tier tier,,) = _check(shop, PER_TX + 1, _att(shop));
        assertEq(uint8(tier), uint8(Tier.PROVEN));
        assertEq(reason, Reason.PER_TX, "attested payee still faces perTxCap");
        assertTrue(_handle(_payOp(shop, 5e6, _att(shop))));
        bytes memory capsAfter = abi.encode(
            ad.globalBucket(address(usdc)).burst,
            ad.globalBucket(address(usdc)).ratePerDay,
            ad.exploreBucket(address(usdc)).burst,
            ad.exploreBucket(address(usdc)).ratePerDay,
            ad.explorePerTxCap(address(usdc)),
            ad.keyAsset(agent, address(usdc)).perTxCap
        );
        assertEq(capsAfter, capsBefore, "no cap changed");
    }

    // ================================================================ F25: replay

    function test_F25_wrongChainIsUnproven() public {
        bytes memory onBase = _attFor(ATTESTOR_PK, address(acct), 8453, shop, 1, _until(), 1);
        (, Tier tier,,) = _check(shop, 0.1e6, onBase);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "Base attestation on this chain");
        bytes memory here = _att(shop);
        vm.chainId(8453);
        (, tier,,) = _check(shop, 0.1e6, here);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "this chain's attestation on Base");
        (, tier,,) = _check(shop, 0.1e6, onBase);
        assertEq(uint8(tier), uint8(Tier.PROVEN), "control");
    }

    function test_F25_wrongWalletIsUnproven() public {
        AgentAccount acct2 = factory.createAccount(owner, 1);
        _configureDemo(acct2, agent2);
        vm.prank(owner);
        AgentAccountAdmin(payable(address(acct2))).setAttestor(attestorAddr);
        bytes memory forA = _att(shop);
        bytes memory forB = _attFor(ATTESTOR_PK, address(acct2), block.chainid, shop, 1, _until(), 1);
        (, Tier tier,,) = acct2.policyCheck(agent2, _payCd(shop, 0.1e6), forA, "");
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "wallet A's attestation at wallet B");
        (, tier,,) = acct2.policyCheck(agent2, _payCd(shop, 0.1e6), forB, "");
        assertEq(uint8(tier), uint8(Tier.PROVEN));
        (, tier,,) = _check(shop, 0.1e6, forB);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "wallet B's attestation at wallet A");
    }

    function test_F25_oldAndFutureEpochIsUnproven() public {
        bytes memory e1 = _att(shop);
        bytes memory e2 = _attFor(ATTESTOR_PK, address(acct), block.chainid, shop, 1, _until(), 2);
        (, Tier tier,,) = _check(shop, 0.1e6, e2);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "future epoch");
        vm.prank(owner);
        admin.bumpEpoch();
        (, tier,,) = _check(shop, 0.1e6, e1);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "old epoch voided in one tx");
        (, tier,,) = _check(shop, 0.1e6, e2);
        assertEq(uint8(tier), uint8(Tier.PROVEN));
    }

    /// The ATT lane's golden vectors (contracts/test/vectors/score_attestation.json), run on real
    /// AgentAccount clones placed at the vector wallets: digests equal, PROVEN iff expectProven.
    function test_F25_attestorVectors() public {
        string memory j = M4Vectors.JSON;
        address vAttestor = vm.parseJsonAddress(j, ".attestor");
        assertEq(TypedData.SCORE_ATTESTATION_TYPEHASH, vm.parseJsonBytes32(j, ".typeHash"));
        assertEq(TypedData.DOMAIN_TYPEHASH, vm.parseJsonBytes32(j, ".domainTypeHash"));
        uint256 n;
        for (uint256 i; vm.keyExistsJson(j, string.concat(".cases[", vm.toString(i), "]")); ++i) {
            _vectorCase(j, string.concat(".cases[", vm.toString(i), "]"), vAttestor);
            ++n;
        }
        for (uint256 i; vm.keyExistsJson(j, string.concat(".replays[", vm.toString(i), "]")); ++i) {
            _vectorReplay(j, string.concat(".replays[", vm.toString(i), "]"), vAttestor);
            ++n;
        }
        assertEq(n, 12, "8 cases + 4 replays");
    }

    // ================================================================ F26: freshness via validationData

    function test_F26_validationDataCarriesAttestationValidUntil() public {
        uint48 attUntil = uint48(block.timestamp + 3 hours);
        bytes memory a = _attFor(ATTESTOR_PK, address(acct), block.chainid, shop, 1, attUntil, 1);
        PackedUserOperation memory op = _payOp(shop, 5e6, a);
        bytes32 h = ep.getUserOpHash(op);
        vm.prank(address(ep));
        uint256 vd = acct.validateUserOp(op, h, 0);
        assertEq(uint160(vd), 0, "signature ok");
        assertEq(uint48(vd >> 160), attUntil, "validUntil = the attestation's");
        (, Session memory s) = _session();
        assertEq(uint48(vd >> 208), s.validAfter);
        // an attestation outliving the session never extends it
        bytes memory longA = _attFor(ATTESTOR_PK, address(acct), block.chainid, shop, 1, type(uint48).max, 1);
        PackedUserOperation memory op2 = _payOp(shop, 5e6, longA);
        (,, uint48 vu) = acct.checkUserOp(op2, ep.getUserOpHash(op2));
        assertEq(vu, s.validUntil);
    }

    function test_F26_validationNeverReadsTheClock() public {
        uint48 attUntil = uint48(block.timestamp + 3 hours);
        bytes memory a = _attFor(ATTESTOR_PK, address(acct), block.chainid, shop, 1, attUntil, 1);
        PackedUserOperation memory op = _payOp(shop, 5e6, a);
        bytes32 h = ep.getUserOpHash(op);
        (uint16 r0, uint48 va0, uint48 vu0) = acct.checkUserOp(op, h);
        uint256 t0 = block.timestamp;
        uint256[3] memory ts = [t0 - 30 days, t0 + 1 days, t0 + 400 days];
        for (uint256 i; i < 3; ++i) {
            vm.warp(ts[i]);
            (uint16 r, uint48 va, uint48 vu) = acct.checkUserOp(op, h);
            assertEq(r, r0);
            assertEq(va, va0);
            assertEq(vu, vu0);
        }
        vm.warp(attUntil + 1);
        _expectFailedOp(op, "AA22 expired or not due");
        vm.warp(attUntil);
        assertTrue(_handle(op), "valid up to and including validUntil");
        assertEq(usdc.balanceOf(shop), 5e6);
        assertEq(r0, Reason.OK);
        assertEq(vu0, attUntil);
    }

    function test_F26_zeroValidUntilNeverMeansForever() public view {
        // EntryPoint reads validUntil = 0 as "no expiry": an attestation must never fold a 0 in.
        bytes memory zero = _attFor(ATTESTOR_PK, address(acct), block.chainid, shop, 1, 0, 1);
        (uint16 reason, Tier tier,, uint48 until) = _check(shop, 5e6, zero);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN));
        assertEq(reason, Reason.EXPLORE_PER_TX);
        assertEq(until, _sessionUntil());
        PackedUserOperation memory op = _payOp(shop, 0.1e6, zero);
        (uint16 r,, uint48 vu) = acct.checkUserOp(op, ep.getUserOpHash(op));
        assertEq(r, Reason.OK);
        assertEq(vu, _sessionUntil());
        assertTrue(vu != 0);
    }

    // ================================================================ F27: attestor key separation

    function test_F27_setAttestorRefusesLiveAgentKey() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.AgentKeyActive.selector, agent));
        admin.setAttestor(agent);
        admin.revoke(agent);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.AgentKeyActive.selector, agent));
        admin.setAttestor(agent); // a revoked key keeps its session: still refused
        vm.stopPrank();
        assertEq(admin.attestor(), attestorAddr);
    }

    function test_F27_setPolicyRefusesAttestor() public {
        PolicyInput memory p = _demoPolicy();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.BadAddress.selector, attestorAddr));
        admin.setPolicy(attestorAddr, p);
    }

    function test_F27_agentSignedAttestationNeverUpgrades() public view {
        bytes memory a = _attFor(AGENT_PK, address(acct), block.chainid, attacker, 1, _until(), 1);
        (uint16 reason, Tier tier,,) = _check(attacker, 5e6, a);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "a hijacked agent cannot self-attest");
        assertEq(reason, Reason.EXPLORE_PER_TX);
    }

    function test_F27_rotatedAttestorLosesAllPower() public {
        bytes memory old = _att(shop);
        address att2 = vm.addr(ATTESTOR2_PK);
        vm.prank(owner);
        admin.setAttestor(att2);
        (, Tier tier,,) = _check(shop, 0.1e6, old);
        assertEq(uint8(tier), uint8(Tier.UNPROVEN), "old attestor's attestations void");
        vm.prank(attestorAddr);
        vm.expectRevert(AccountCommon.NotOwnerOrAttestor.selector);
        admin.flag(attacker);
        bytes memory fresh = _attFor(ATTESTOR2_PK, address(acct), block.chainid, shop, 1, _until(), 1);
        (, tier,,) = _check(shop, 0.1e6, fresh);
        assertEq(uint8(tier), uint8(Tier.PROVEN));
        vm.prank(att2);
        admin.flag(attacker);
        assertTrue(admin.isFlagged(attacker));
    }

    function test_F27_attestorKeyCannotSignUserOps() public {
        PackedUserOperation memory op = _op(address(acct), _agentNonce(acct, agent), _payCd(attacker, 1));
        op = _signAgentWith(op, ATTESTOR_PK, "", "");
        assertEq(_reason(acct, op), Reason.NO_SESSION);
        _expectAA24(op);
        PackedUserOperation memory raw = _op(address(acct), ep.getNonce(address(acct), 0), _payCd(attacker, 1));
        raw = _signOwner(raw, ATTESTOR_PK);
        _expectAA24(raw);
    }

    // ================================================================ F31: gas bound

    function test_F31_overCapExplorationCostsNoGas() public {
        (, Session memory s0) = _session();
        _expectAA24(_payOp(attacker, EXPLORE_PER_TX + 1, ""));
        (, Session memory s1) = _session();
        assertEq(s1.gas.gasCredit, s0.gas.gasCredit, "refused in validation: no prefund, no credit");
    }

    function test_F31_blockedAfterValidationBoundedByGasCredit() public {
        uint256 maxCost = M4Lib.MAX_COST;
        vm.prank(owner);
        admin.setGasCredit(agent, uint128(maxCost));
        PackedUserOperation memory agentOp = _payOp(shop, 5e6, _att(shop));
        bytes32 h = ep.getUserOpHash(agentOp);
        uint256 bundlerBefore = bundler.balance;
        Vm.Log[] memory logs = _run(_pair(_ownerAdminOp(abi.encodeCall(AgentAccountAdmin.bumpEpoch, ())), agentOp));
        (bool found, bool success, uint256 cost) = _opResult(logs, h);
        assertTrue(found && success, "blocked in execution, success=true");
        (bool blocked,) = _blockedWhy(logs);
        assertTrue(blocked);
        assertLe(cost, maxCost, "bundler income from the agent op <= the debited max cost");
        assertGt(bundler.balance, bundlerBefore);
        (, Session memory s) = _session();
        assertEq(s.gas.gasCredit, 0, "credit debited by maxCost in validation");
        PackedUserOperation memory next = _payOp(shop, 0.1e6, _att(shop));
        uint16 r = _reason(acct, next);
        assertTrue(r == Reason.GAS_CREDIT || r == Reason.FROZEN, "no more ops without a refill");
        _expectAA24(next);
        assertEq(usdc.balanceOf(shop), 0);
    }

    // ================================================================ helpers

    function _resize(bytes memory b, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len && i < b.length; ++i) {
            out[i] = b[i];
        }
    }

    function _setWord(bytes memory b, uint256 wordIndex, uint256 value) internal pure returns (bytes memory out) {
        out = _resize(b, b.length);
        assembly ("memory-safe") {
            mstore(add(add(out, 0x20), mul(wordIndex, 0x20)), value)
        }
    }

    function _vrs(bytes memory a) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        assembly ("memory-safe") {
            r := mload(add(a, 0xc0))
            s := mload(add(a, 0xe0))
            v := byte(0, mload(add(a, 0x100)))
        }
    }

    /// A real AgentAccount clone at `wallet` (vector addresses are anvil deployer nonces), demo
    /// policy for `agent`, attestor = the vector attestor, attestEpoch = `epoch`.
    function _vectorAccount(address wallet, address vAttestor, uint64 epoch) internal returns (AgentAccount a) {
        a = AgentAccount(payable(wallet));
        AgentAccountAdmin ad = AgentAccountAdmin(payable(wallet));
        if (wallet.code.length == 0) {
            vm.etch(wallet, address(acct).code);
            a.initialize(owner);
            vm.startPrank(owner);
            ad.setGlobalCap(address(usdc), CAP_BURST, CAP_RATE);
            ad.setPolicy(agent, _demoPolicy());
            ad.setAttestor(vAttestor);
            vm.stopPrank();
        }
        bytes32 slot = bytes32(uint256(AccountStorage.SLOT) + 1); // attestor (20 B) | attestEpoch (8 B)
        uint256 w = uint256(vm.load(wallet, slot));
        w = (w & ~(uint256(type(uint64).max) << 160)) | (uint256(epoch) << 160);
        vm.store(wallet, slot, bytes32(w));
        assertEq(ad.attestEpoch(), epoch, "epoch slot");
        assertEq(ad.attestor(), vAttestor, "attestor untouched");
    }

    function _u(string memory j, string memory k) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(j, k));
    }

    struct V {
        uint256 chainId;
        address wallet;
        address recipient;
        uint8 tier;
        uint48 until;
        uint64 epoch;
        bytes sig;
        bytes attestation;
        bool expectProven;
    }

    function _loadCase(string memory j, string memory p) internal pure returns (V memory v) {
        v.chainId = _u(j, string.concat(p, ".chainId"));
        v.wallet = vm.parseJsonAddress(j, string.concat(p, ".wallet"));
        v.recipient = vm.parseJsonAddress(j, string.concat(p, ".recipient"));
        v.tier = uint8(_u(j, string.concat(p, ".tier")));
        v.until = uint48(_u(j, string.concat(p, ".validUntil")));
        v.epoch = uint64(_u(j, string.concat(p, ".epoch")));
        v.sig = vm.parseJsonBytes(j, string.concat(p, ".signature"));
        v.attestation = vm.parseJsonBytes(j, string.concat(p, ".attestation"));
        v.expectProven = vm.parseJsonBool(j, string.concat(p, ".expectProven"));
    }

    function _vectorCase(string memory j, string memory p, address vAttestor) internal {
        V memory v = _loadCase(j, p);
        bytes32 ds = TypedData.domainSeparator(v.chainId, v.wallet);
        bytes32 sh = TypedData.hashScoreAttestation(TypedData.ScoreAttestation(v.recipient, v.tier, v.until, v.epoch));
        assertEq(ds, vm.parseJsonBytes32(j, string.concat(p, ".domainSeparator")), "domainSeparator");
        assertEq(sh, vm.parseJsonBytes32(j, string.concat(p, ".structHash")), "structHash");
        bytes32 digest = TypedData.digest(ds, sh);
        assertEq(digest, vm.parseJsonBytes32(j, string.concat(p, ".digest")), "digest");
        assertEq(
            ecrecover(digest, uint8(v.sig[64]), bytes32(_slice32(v.sig, 0)), bytes32(_slice32(v.sig, 32))),
            vm.parseJsonAddress(j, string.concat(p, ".signer"))
        );
        assertEq(
            keccak256(abi.encode(v.tier, v.until, v.epoch, v.sig)), keccak256(v.attestation), "attestation layout = docs/api.md 4.3"
        );
        vm.chainId(v.chainId);
        _vectorOnAccount(v, vAttestor, ds);
        vm.chainId(31337);
    }

    function _vectorOnAccount(V memory v, address vAttestor, bytes32 ds) internal {
        AgentAccount a = _vectorAccount(v.wallet, vAttestor, v.epoch);
        assertEq(AgentAccountAdmin(payable(v.wallet)).domainSeparator(), ds, "account domain");
        (uint16 reason, Tier t,, uint48 vu) = a.policyCheck(agent, _payCd(v.recipient, 0.1e6), v.attestation, "");
        assertEq(reason, Reason.OK);
        (, Session memory s) = AgentAccountAdmin(payable(v.wallet)).sessionOf(agent);
        if (v.expectProven) {
            assertEq(uint8(t), uint8(Tier.PROVEN), "vector must upgrade");
            assertEq(vu, v.until < s.validUntil ? v.until : s.validUntil);
        } else {
            assertEq(uint8(t), uint8(Tier.UNPROVEN), "vector must not upgrade");
            assertEq(vu, s.validUntil);
        }
    }

    function _vectorReplay(string memory j, string memory p, address vAttestor) internal {
        bytes memory attestation = vm.parseJsonBytes(j, string.concat(p, ".attestation"));
        uint256 chainId = _u(j, string.concat(p, ".checkChainId"));
        address wallet = vm.parseJsonAddress(j, string.concat(p, ".checkWallet"));
        address recipient = vm.parseJsonAddress(j, string.concat(p, ".checkRecipient"));
        uint64 epoch = uint64(_u(j, string.concat(p, ".checkEpoch")));
        (uint8 tier, uint48 until,,) = abi.decode(attestation, (uint8, uint48, uint64, bytes));
        bytes32 ctx = TypedData.digest(
            TypedData.domainSeparator(chainId, wallet),
            TypedData.hashScoreAttestation(TypedData.ScoreAttestation(recipient, tier, until, epoch))
        );
        assertEq(ctx, vm.parseJsonBytes32(j, string.concat(p, ".contextDigest")), "replay context digest");
        assertFalse(vm.parseJsonBool(j, string.concat(p, ".expectProven")));
        vm.chainId(chainId);
        AgentAccount a = _vectorAccount(wallet, vAttestor, epoch);
        (, Tier t,,) = a.policyCheck(agent, _payCd(recipient, 0.1e6), attestation, "");
        assertEq(uint8(t), uint8(Tier.UNPROVEN), "replay must not upgrade");
        vm.chainId(31337);
    }

    function _slice32(bytes memory b, uint256 off) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 0x20), off))
        }
    }
}
