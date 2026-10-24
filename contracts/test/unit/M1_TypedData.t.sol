// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {M1Fixture} from "./M1_Fixture.sol";
import {TypedData} from "../../src/lib/TypedData.sol";

/// EIP-712 types of the account (docs/api.md section 5). Two independent readers must agree:
/// lib/TypedData (what the modules use) and Foundry's eip712HashTypedData over the JSON form
/// (what viem / MetaMask sign). Writes results/m1_typed_data_vectors.json for the TS parity tests.
contract M1TypedDataTest is M1Fixture {
    address internal constant RECIPIENT = 0x1111111111111111111111111111111111111111;
    address internal constant TARGET = 0x2222222222222222222222222222222222222222;
    address internal constant PAYEE = 0x3333333333333333333333333333333333333333;
    address internal constant ASSET = 0x4444444444444444444444444444444444444444;
    bytes32 internal constant CALLDATA_HASH = keccak256("agent op callData");

    function setUp() public {
        _setUpFixture();
    }

    function _domainJson() internal view returns (string memory) {
        return string.concat(
            '{"name":"AgentAccount","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(acct)),
            '"}'
        );
    }

    string internal constant DOMAIN_TYPE =
        '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}]';

    function _attestation() internal pure returns (TypedData.ScoreAttestation memory) {
        return TypedData.ScoreAttestation(RECIPIENT, 1, 1_800_086_400, 1);
    }

    function _approval() internal view returns (TypedData.OutcomeApproval memory a) {
        a.account = address(acct);
        a.chainId = block.chainid;
        a.nonce = 7;
        a.target = TARGET;
        a.selector = 0xa9059cbb;
        a.payee = PAYEE;
        a.maxOutflow = new TypedData.AssetAmount[](2);
        a.maxOutflow[0] = TypedData.AssetAmount(ASSET, 40e6);
        a.maxOutflow[1] = TypedData.AssetAmount(address(0), 1e15);
        a.callDataHash = CALLDATA_HASH;
        a.validUntil = 1_800_518_400;
    }

    function test_typedData_domainMatchesAccount() public view {
        bytes32 ds = TypedData.domainSeparator(block.chainid, address(acct));
        assertEq(admin.domainSeparator(), ds, "admin view");
        (, string memory name, string memory version, uint256 chainId, address vc,,) = acct.eip712Domain();
        assertEq(name, "AgentAccount");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(acct), "clone's own address, not the implementation");
    }

    function test_typedData_scoreAttestationParity() public {
        TypedData.ScoreAttestation memory a = _attestation();
        bytes32 digest = TypedData.digest(admin.domainSeparator(), TypedData.hashScoreAttestation(a));
        string memory json = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"ScoreAttestation":[{"name":"recipient","type":"address"},{"name":"tier","type":"uint8"},{"name":"validUntil","type":"uint48"},{"name":"epoch","type":"uint64"}]},"primaryType":"ScoreAttestation","domain":',
            _domainJson(),
            ',"message":{"recipient":"',
            vm.toString(a.recipient),
            '","tier":1,"validUntil":1800086400,"epoch":1}}'
        );
        assertEq(vm.eip712HashTypedData(json), digest, "lib/TypedData == JSON typed data");
    }

    function test_typedData_outcomeApprovalParity() public {
        TypedData.OutcomeApproval memory a = _approval();
        bytes32 digest = TypedData.digest(admin.domainSeparator(), TypedData.hashOutcomeApproval(a));
        string memory json = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"AssetAmount":[{"name":"asset","type":"address"},{"name":"amount","type":"uint256"}],"OutcomeApproval":[{"name":"account","type":"address"},{"name":"chainId","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"target","type":"address"},{"name":"selector","type":"bytes4"},{"name":"payee","type":"address"},{"name":"maxOutflow","type":"AssetAmount[]"},{"name":"callDataHash","type":"bytes32"},{"name":"validUntil","type":"uint48"}]},"primaryType":"OutcomeApproval","domain":',
            _domainJson(),
            ',"message":{"account":"',
            vm.toString(address(acct)),
            '","chainId":',
            vm.toString(block.chainid),
            ',"nonce":7,"target":"',
            vm.toString(TARGET),
            '","selector":"0xa9059cbb","payee":"',
            vm.toString(PAYEE),
            '","maxOutflow":[{"asset":"',
            vm.toString(ASSET),
            '","amount":40000000},{"asset":"0x0000000000000000000000000000000000000000","amount":1000000000000000}],"callDataHash":"',
            vm.toString(CALLDATA_HASH),
            '","validUntil":1800518400}}'
        );
        assertEq(vm.eip712HashTypedData(json), digest, "lib/TypedData == JSON typed data");
    }

    function _attJson(bytes32 ds) internal view returns (string memory) {
        TypedData.ScoreAttestation memory s = _attestation();
        bytes32 sh = TypedData.hashScoreAttestation(s);
        return string.concat(
            '{"recipient":"', vm.toString(s.recipient), '","tier":1,"validUntil":1800086400,"epoch":1,"structHash":"',
            vm.toString(sh), '","digest":"', vm.toString(TypedData.digest(ds, sh)), '"}'
        );
    }

    function _apprInputsJson() internal view returns (string memory) {
        return string.concat(
            '{"account":"', vm.toString(address(acct)), '","chainId":', vm.toString(block.chainid),
            ',"nonce":7,"target":"', vm.toString(TARGET), '","selector":"0xa9059cbb","payee":"', vm.toString(PAYEE),
            '","maxOutflow":[{"asset":"', vm.toString(ASSET),
            '","amount":"40000000"},{"asset":"0x0000000000000000000000000000000000000000","amount":"1000000000000000"}],"callDataHash":"',
            vm.toString(CALLDATA_HASH), '","validUntil":1800518400'
        );
    }

    function _apprJson(bytes32 ds) internal view returns (string memory) {
        bytes32 ah = TypedData.hashOutcomeApproval(_approval());
        return string.concat(
            _apprInputsJson(), ',"structHash":"', vm.toString(ah), '","digest":"', vm.toString(TypedData.digest(ds, ah)), '"}'
        );
    }

    /// Writes the reference vectors (inputs, struct hashes, digests) for packages/shared and the services.
    function test_typedData_writeVectors() public {
        bytes32 ds = admin.domainSeparator();
        string memory head = string.concat(
            '{"chainId":', vm.toString(block.chainid), ',"verifyingContract":"', vm.toString(address(acct)),
            '","name":"AgentAccount","version":"1","domainSeparator":"', vm.toString(ds),
            '","scoreAttestationTypehash":"', vm.toString(TypedData.SCORE_ATTESTATION_TYPEHASH),
            '","outcomeApprovalTypehash":"', vm.toString(TypedData.OUTCOME_APPROVAL_TYPEHASH), '"'
        );
        string memory out =
            string.concat(head, ',"scoreAttestation":', _attJson(ds), ',"outcomeApproval":', _apprJson(ds), "}");
        vm.writeFile("../results/m1_typed_data_vectors.json", out);
        assertGt(bytes(out).length, 0);
    }
}
