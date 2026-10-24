// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AccountCommon} from "./AgentAccountBase.sol";
import {AccountStorage} from "./lib/AccountStorage.sol";
import {ArgRules} from "./lib/ArgRules.sol";
import {Buckets} from "./lib/Buckets.sol";
import {TypedData} from "./lib/TypedData.sol";
import {FreezeAdmin, FreezeStorage} from "./modules/FreezeModule.sol";
import {RecoveryModule} from "./modules/RecoveryModule.sol";
import {
    Session,
    AssetLimit,
    RuleSet,
    RuleRef,
    ArgRule,
    Bucket,
    Voucher,
    PolicyInput,
    AssetInput,
    CallRuleInput,
    SIG1271_OWNER_PLUS_X402_VOUCHER
} from "./lib/PolicyTypes.sol";

/// @title AgentAccountAdmin: the owner setters and the views of AgentAccount (IDEA.md 7.1).
/// @notice Never used on its own address. AgentAccount's fallback DELEGATECALLs every selector it
///         does not implement to this contract, so these functions run on the account's storage
///         (ERC-7201 layout in lib/AccountStorage) with the original msg.sender. Split out to keep
///         AgentAccount under the 24,576-byte EIP-170 limit with room for the four modules.
///         Only the owner (or the account itself, i.e. an owner op) may write; the attestor may
///         only `flag` (I10). The agent path can never reach this code: agent ops cannot target
///         the account (I2).
///         Also carries the admin side of FreezeModule (freeze / unfreeze / setWatcher) and the
///         RecoveryModule (guardians), owned by lanes FRZ and REC.
contract AgentAccountAdmin is AccountCommon, FreezeAdmin, RecoveryModule {
    using AccountStorage for AccountStorage.Layout;
    using Buckets for Bucket;

    IEntryPoint internal immutable _ep;

    modifier onlyOwner() {
        if (!_isOwnerCaller()) revert NotOwner();
        _;
    }

    constructor(IEntryPoint entryPoint_) {
        _ep = entryPoint_;
    }


    function transferOwnership(address newOwner) external onlyOwner {
        AccountStorage.Layout storage l = _l();
        if (newOwner == address(0) || newOwner == address(this) || l.keyToSession[newOwner] != 0) {
            revert BadAddress(newOwner);
        }
        emit OwnerChanged(l.owner, newOwner);
        l.owner = newOwner;
    }

    function _checkNewKey(AccountStorage.Layout storage l, address key) internal view {
        if (
            key == address(0) || key == l.owner || key == address(this) || key == l.attestor
                || key == FreezeStorage.layout().watcher
        ) revert BadAddress(key);
    }

    function _newNonceKey(AccountStorage.Layout storage l, address key) internal returns (uint192) {
        uint32 salt = ++l.nonceSalt;
        return (uint192(uint160(key)) << 32) | (uint192(salt & 0xFFFFFF) << 8);
    }

    /// Create or replace the policy of `agentKey`. Every call starts a fresh rule / asset generation
    /// (old rules, per-key bucket levels and queued ops under the old nonce key all die).
    function setPolicy(address agentKey, PolicyInput calldata p) external onlyOwner {
        AccountStorage.Layout storage l = _l();
        _checkNewKey(l, agentKey);
        if (p.validUntil == 0 || p.validUntil == type(uint48).max || p.validUntil <= p.validAfter) {
            revert OpenEndedKey(p.validAfter, p.validUntil);
        }
        uint64 sid = l.keyToSession[agentKey];
        if (sid == 0) {
            sid = ++l.nextSessionId;
            l.keyToSession[agentKey] = sid;
        }
        Session storage s = l.sessions[sid];
        s.agentKey = agentKey;
        s.validAfter = p.validAfter;
        s.validUntil = p.validUntil;
        s.revoked = false;
        s.gen += 1;
        s.nonceKey = _newNonceKey(l, agentKey);
        s.gas = p.gas;
        uint32 gen = s.gen;
        delete l.ruleRefs[sid];
        delete l.keyAssetList[sid];

        for (uint256 i; i < p.assets.length; ++i) {
            AssetInput calldata a = p.assets[i];
            if (!l.isTrackedAsset[a.asset]) revert AssetNoGlobalCap(a.asset);
            AssetLimit storage al = l.keyAssets[AccountStorage.assetKey(sid, gen, a.asset)];
            if (al.enabled) revert DuplicateEntry();
            al.enabled = true;
            al.perTxCap = a.perTxCap;
            al.bucket.configure(a.burst, a.ratePerDay, block.timestamp);
            l.keyAssetList[sid].push(a.asset);
        }
        for (uint256 i; i < p.calls.length; ++i) {
            CallRuleInput calldata c = p.calls[i];
            ArgRules.validateEntry(c, address(this), address(_ep));
            RuleSet storage rs = l.rules[AccountStorage.ruleKey(sid, gen, c.target, c.selector)];
            if (rs.allowed) revert DuplicateEntry();
            rs.allowed = true;
            for (uint256 j; j < c.rules.length; ++j) {
                rs.rules.push(c.rules[j]);
            }
            l.ruleRefs[sid].push(RuleRef(c.target, c.selector));
        }
        emit PolicySet(agentKey, sid, gen, s.nonceKey, p.validAfter, p.validUntil);
    }

    /// Owner kill switch: the key fails validation and execution from the next op on.
    function revoke(address agentKey) external onlyOwner {
        uint64 sid = _sid(agentKey);
        _l().sessions[sid].revoked = true;
        emit Revoked(agentKey, sid);
    }

    /// Move a session (policy, buckets, gas credit) to a new key with a fresh nonce key.
    function rotateKey(address oldKey, address newKey) external onlyOwner {
        AccountStorage.Layout storage l = _l();
        uint64 sid = _sid(oldKey);
        _checkNewKey(l, newKey);
        if (l.keyToSession[newKey] != 0) revert KeyInUse(newKey);
        delete l.keyToSession[oldKey];
        l.keyToSession[newKey] = sid;
        Session storage s = l.sessions[sid];
        s.agentKey = newKey;
        s.nonceKey = _newNonceKey(l, newKey);
        emit KeyRotated(oldKey, newKey, sid, s.nonceKey);
    }

    function setGasCredit(address agentKey, uint128 gasCredit) external onlyOwner {
        _l().sessions[_sid(agentKey)].gas.gasCredit = gasCredit;
        emit GasCreditSet(agentKey, gasCredit);
    }

    function setRecipient(address recipient, bool listed) external onlyOwner {
        AccountStorage.Layout storage l = _l();
        if (recipient == address(0) || recipient == address(this)) revert BadAddress(recipient);
        if (listed && !l.recipients[recipient]) l.recipientList.push(recipient);
        l.recipients[recipient] = listed;
        emit RecipientSet(recipient, listed);
    }

    /// Account-wide bucket for `asset` (NATIVE = ETH), shared by every key and both tracks.
    /// The first call also tracks the asset and sets the 7.1 exploration defaults
    /// (exploreCap = 5% of the cap per 24 h, explorePerTxCap = 1% of the cap).
    function setGlobalCap(address asset, uint128 burst, uint128 ratePerDay) external onlyOwner {
        AccountStorage.Layout storage l = _l();
        l.globalBucket[asset].configure(burst, ratePerDay, block.timestamp);
        if (!l.isTrackedAsset[asset]) {
            l.isTrackedAsset[asset] = true;
            l.trackedAssets.push(asset);
            uint256 cap = uint256(burst) + ratePerDay;
            (uint128 eb, uint128 er) = Buckets.split(cap * 5 / 100);
            l.exploreBucket[asset].configure(eb, er, block.timestamp);
            l.explorePerTxCap[asset] = uint128(cap / 100);
            emit ExploreCapSet(asset, eb, er);
            emit ExplorePerTxCapSet(asset, uint128(cap / 100));
        }
        emit GlobalCapSet(asset, burst, ratePerDay);
    }

    function setExploreCap(address asset, uint128 burst, uint128 ratePerDay) external onlyOwner {
        _l().exploreBucket[asset].configure(burst, ratePerDay, block.timestamp);
        emit ExploreCapSet(asset, burst, ratePerDay);
    }

    function setExplorePerTxCap(address asset, uint128 cap) external onlyOwner {
        _l().explorePerTxCap[asset] = cap;
        emit ExplorePerTxCapSet(asset, cap);
    }

    function setSig1271Mode(uint8 mode) external onlyOwner {
        if (mode > SIG1271_OWNER_PLUS_X402_VOUCHER) revert BadMode(mode);
        _l().sig1271Mode = mode;
        emit Sig1271ModeSet(mode);
    }

    /// The attestor may only `flag` (I10). It can never be a live agent key (F27).
    function setAttestor(address attestor_) external onlyOwner {
        AccountStorage.Layout storage l = _l();
        if (attestor_ == address(this)) revert BadAddress(attestor_);
        if (attestor_ != address(0) && l.keyToSession[attestor_] != 0) revert AgentKeyActive(attestor_);
        l.attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    /// Voids every outstanding attestation in one tx.
    function bumpEpoch() external onlyOwner {
        emit EpochBumped(++_l().attestEpoch);
    }

    /// Escalate-only: the attestor (or the owner) flags a payee; only the owner clears it.
    function flag(address payee) external {
        AccountStorage.Layout storage l = _l();
        if (!(_isOwnerCaller() || (msg.sender == l.attestor && msg.sender != address(0)))) {
            revert NotOwnerOrAttestor();
        }
        l.flagged[payee] = true;
        emit Flagged(payee, msg.sender);
    }

    function unflag(address payee) external onlyOwner {
        _l().flagged[payee] = false;
        emit Unflagged(payee);
    }

    /// The only paymaster agent ops may name in paymasterAndData (0 = agent ops cannot use one).
    function setAgentPaymaster(address paymaster) external onlyOwner {
        if (paymaster == address(this)) revert BadAddress(paymaster);
        _l().agentPaymaster = paymaster;
        emit AgentPaymasterSet(paymaster);
    }

    function setTrackedSpenders(address[] calldata spenders) external onlyOwner {
        _l().trackedSpenders = spenders;
        emit TrackedSpendersSet(spenders);
    }

    function setTrackedNFTs(address[] calldata nfts) external onlyOwner {
        _l().trackedNFTs = nfts;
        emit TrackedNFTsSet(nfts);
    }

    function addDeposit() external payable {
        _ep.depositTo{value: msg.value}(address(this));
    }

    function withdrawDepositTo(address payable to, uint256 amount) external onlyOwner {
        _ep.withdrawTo(to, amount);
    }

    function _sid(address agentKey) internal view returns (uint64 sid) {
        sid = _l().keyToSession[agentKey];
        if (sid == 0) revert UnknownKey(agentKey);
    }

    // ================================================================ views

    function owner() external view returns (address) {
        return _l().owner;
    }

    function agentPaymaster() external view returns (address) {
        return _l().agentPaymaster;
    }

    function sig1271Mode() external view returns (uint8) {
        return _l().sig1271Mode;
    }

    function attestor() external view returns (address) {
        return _l().attestor;
    }

    function attestEpoch() external view returns (uint64) {
        return _l().attestEpoch;
    }

    function isRecipient(address a) external view returns (bool) {
        return _l().recipients[a];
    }

    function recipientList() external view returns (address[] memory) {
        return _l().recipientList;
    }

    function isFlagged(address a) external view returns (bool) {
        return _l().flagged[a];
    }

    function globalBucket(address asset) external view returns (Bucket memory) {
        return _l().globalBucket[asset];
    }

    function exploreBucket(address asset) external view returns (Bucket memory) {
        return _l().exploreBucket[asset];
    }

    function explorePerTxCap(address asset) external view returns (uint128) {
        return _l().explorePerTxCap[asset];
    }

    function trackedAssets() external view returns (address[] memory) {
        return _l().trackedAssets;
    }

    function trackedSpenders() external view returns (address[] memory) {
        return _l().trackedSpenders;
    }

    function trackedNFTs() external view returns (address[] memory) {
        return _l().trackedNFTs;
    }

    function voucher(bytes32 nonce) external view returns (Voucher memory) {
        return _l().vouchers[nonce];
    }

    function sessionOf(address agentKey) external view returns (uint64 sid, Session memory s) {
        sid = _l().keyToSession[agentKey];
        s = _l().sessions[sid];
    }

    function keyAsset(address agentKey, address asset) external view returns (AssetLimit memory) {
        AccountStorage.Layout storage l = _l();
        return l.keyAsset(l.keyToSession[agentKey], asset);
    }

    function keyAssets(address agentKey) external view returns (address[] memory) {
        AccountStorage.Layout storage l = _l();
        return l.keyAssetList[l.keyToSession[agentKey]];
    }

    function ruleOf(address agentKey, address target, bytes4 selector)
        external
        view
        returns (bool allowed, ArgRule[] memory rules)
    {
        AccountStorage.Layout storage l = _l();
        RuleSet storage rs = l.ruleSet(l.keyToSession[agentKey], target, selector);
        return (rs.allowed, rs.rules);
    }

    function rulesOf(address agentKey) external view returns (RuleRef[] memory) {
        AccountStorage.Layout storage l = _l();
        return l.ruleRefs[l.keyToSession[agentKey]];
    }

    /// The nonce key an agent op of `agentKey` must use in `lane` (LANE_NORMAL / LANE_APPROVAL).
    function nonceKeyOf(address agentKey, uint8 lane) external view returns (uint192) {
        AccountStorage.Layout storage l = _l();
        uint64 sid = l.keyToSession[agentKey];
        if (sid == 0) return 0;
        return l.sessions[sid].nonceKey | lane;
    }

    function domainSeparator() external view returns (bytes32) {
        return TypedData.domainSeparator(block.chainid, address(this));
    }

    function getDeposit() external view returns (uint256) {
        return _ep.balanceOf(address(this));
    }
}
