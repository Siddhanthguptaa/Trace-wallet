// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccountCommon} from "../AgentAccountBase.sol";
import {AccountStorage} from "../lib/AccountStorage.sol";

/// @title RecoveryStorage: ERC-7201 namespace "hypnexis.AgentAccount.recovery" (lane REC).
library RecoveryStorage {
    /// @custom:storage-location erc7201:hypnexis.AgentAccount.recovery
    struct Layout {
        address[] guardians;
        mapping(address => bool) isGuardian;
        uint8 threshold;
        // pending proposal
        uint64 proposalId; // increments per proposal, never reused (0 = none ever)
        address pendingOwner; // 0 = no live proposal (none, executed, vetoed or cancelled)
        uint48 proposedAt;
        uint256 approvals; // bitmap over guardian indexes, for proposalId only
        bool vetoed; // the latest proposal was vetoed by the owner
        // REC (M11) fields
        uint8 approvalCount; // popcount of approvals
        uint8 proposerBit; // guardian bit of the latest proposal's proposer
        uint8 barred; // guardian bits barred from proposing (their stale proposal was replaced)
    }

    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.recovery")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0x4c00d54f06551cc3c921bc40ef34572715e8d5c1dc7251f2a57a87bac66d8800;

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            l.slot := slot
        }
    }
}

/// @title RecoveryModule (lane REC, M11): 3-of-5 guardian social recovery of the owner key.
/// @notice Compiled into AgentAccountAdmin (reached through the account's fallback DELEGATECALL, so
///         it runs on the account's storage with the original msg.sender). Rules (IDEA.md 13, I12):
///         - the owner sets exactly 5 distinct guardians, threshold 3;
///         - a guardian proposes a new owner (the proposal counts as its approval); one live
///           proposal at a time;
///         - guardians approve with their own transaction (`msg.sender`), so an approval is bound to
///           this chain (EIP-155 tx), this account (tx target) and the proposal id; ids are never
///           reused and the approval bitmap is per proposal, so approvals cannot be replayed;
///         - anyone executes once >= 3 distinct guardian approvals exist and >= 48 h have passed
///           since the proposal; the owner can veto any time before execution;
///         - `executeRecovery` calls the core hook `_applyRecovery` (new owner, every agent key
///           revoked, attestEpoch bumped). It makes no external call and never moves funds.
///         Liveness: a proposal still under threshold 48 h after it was made is stale and another
///         guardian may replace it; the stale proposer is then barred from proposing until the
///         guardian set is reset or a recovery executes, so a minority cannot block recovery.
abstract contract RecoveryModule is AccountCommon {
    uint256 internal constant GUARDIANS = 5;
    uint256 internal constant THRESHOLD = 3;
    uint256 internal constant RECOVERY_DELAY = 48 hours;

    event GuardiansSet(address[] guardians, uint8 threshold);
    event RecoveryProposed(uint64 indexed proposalId, address indexed newOwner, address indexed by);
    event RecoveryApproved(uint64 indexed proposalId, address indexed guardian);
    event RecoveryVetoed(uint64 indexed proposalId);
    /// A live proposal was dropped by a guardian reset or replaced after going stale.
    event RecoveryCancelled(uint64 indexed proposalId);

    error RecoveryNotEnabled();
    error BadGuardians();
    error NotGuardian();
    error NoRecovery();
    error RecoveryPending(uint64 proposalId);
    error AlreadyApproved();
    error RecoveryNotReady();
    error GuardianBarred();

    /// Owner: replace the guardian set (exactly 5 distinct, threshold 3). Guardians may not be 0,
    /// the owner, the account or a session key. Cancels any live proposal and clears the bars.
    function setGuardians(address[] calldata guardians_, uint8 threshold_) external {
        if (!_isOwnerCaller()) revert NotOwner();
        if (guardians_.length != GUARDIANS || threshold_ != THRESHOLD) revert BadGuardians();
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        AccountStorage.Layout storage l = _l();
        for (uint256 i; i < r.guardians.length; ++i) {
            r.isGuardian[r.guardians[i]] = false;
        }
        for (uint256 i; i < GUARDIANS; ++i) {
            address g = guardians_[i];
            if (g == address(0) || g == l.owner || g == address(this) || r.isGuardian[g] || l.keyToSession[g] != 0) {
                revert BadGuardians();
            }
            r.isGuardian[g] = true;
        }
        r.guardians = guardians_;
        r.threshold = threshold_;
        r.barred = 0;
        if (r.pendingOwner != address(0)) {
            r.pendingOwner = address(0);
            emit RecoveryCancelled(r.proposalId);
        }
        emit GuardiansSet(guardians_, threshold_);
    }

    /// Guardian: propose `newOwner`. Refused while a live proposal exists, unless that one is stale
    /// (under threshold and >= 48 h old), in which case it is replaced and its proposer barred.
    function proposeRecovery(address newOwner) external {
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        if (r.threshold == 0) revert RecoveryNotEnabled();
        uint256 bit = _guardianBit(r);
        AccountStorage.Layout storage l = _l();
        if (
            newOwner == address(0) || newOwner == address(this) || newOwner == l.owner || r.isGuardian[newOwner]
                || l.keyToSession[newOwner] != 0
        ) revert BadAddress(newOwner);
        if (r.pendingOwner != address(0)) {
            if (r.approvalCount >= THRESHOLD || block.timestamp < uint256(r.proposedAt) + RECOVERY_DELAY) {
                revert RecoveryPending(r.proposalId);
            }
            r.barred |= r.proposerBit;
            emit RecoveryCancelled(r.proposalId);
        }
        if (r.barred & bit != 0) revert GuardianBarred();
        uint64 id = ++r.proposalId;
        r.pendingOwner = newOwner;
        r.proposedAt = uint48(block.timestamp);
        r.approvals = bit;
        r.approvalCount = 1;
        r.proposerBit = uint8(bit);
        r.vetoed = false;
        emit RecoveryProposed(id, newOwner, msg.sender);
        emit RecoveryApproved(id, msg.sender);
    }

    /// Guardian: approve live proposal `proposalId` (once per guardian per proposal).
    function approveRecovery(uint64 proposalId) external {
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        uint256 bit = _guardianBit(r);
        if (r.pendingOwner == address(0) || proposalId != r.proposalId) revert NoRecovery();
        if (r.approvals & bit != 0) revert AlreadyApproved();
        r.approvals |= bit;
        ++r.approvalCount;
        emit RecoveryApproved(proposalId, msg.sender);
    }

    /// Anyone: execute the live proposal once it has >= 3 distinct guardian approvals and >= 48 h
    /// have passed since it was made. One shot: the proposal is consumed before the owner changes.
    function executeRecovery() external {
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        address newOwner = r.pendingOwner;
        if (newOwner == address(0)) revert NoRecovery();
        if (r.approvalCount < THRESHOLD || block.timestamp < uint256(r.proposedAt) + RECOVERY_DELAY) {
            revert RecoveryNotReady();
        }
        r.pendingOwner = address(0);
        r.barred = 0;
        _applyRecovery(newOwner);
    }

    /// Owner veto of the live proposal, any time before execution.
    function vetoRecovery() external {
        if (!_isOwnerCaller()) revert NotOwner();
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        if (r.pendingOwner == address(0)) revert NoRecovery();
        r.pendingOwner = address(0);
        r.vetoed = true;
        emit RecoveryVetoed(r.proposalId);
    }

    /// msg.sender's guardian bit. A guardian that is (or ever was) a session key cannot act.
    function _guardianBit(RecoveryStorage.Layout storage r) private view returns (uint256) {
        address[] storage g = r.guardians;
        for (uint256 i; i < g.length; ++i) {
            if (g[i] == msg.sender && _l().keyToSession[msg.sender] == 0) return 1 << i;
        }
        revert NotGuardian();
    }

    function guardians() external view returns (address[] memory, uint8) {
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        return (r.guardians, r.threshold);
    }

    function pendingRecovery()
        external
        view
        returns (uint64 proposalId, address newOwner, uint48 proposedAt, uint256 approvals, bool vetoed)
    {
        RecoveryStorage.Layout storage r = RecoveryStorage.layout();
        return (r.proposalId, r.pendingOwner, r.proposedAt, r.approvals, r.vetoed);
    }
}
