// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { CourtTypes } from "../src/CourtTypes.sol";
import { MandateRegistry } from "../src/MandateRegistry.sol";
import { MandateEscrow } from "../src/MandateEscrow.sol";
import { SettlementAdapter } from "../src/SettlementAdapter.sol";
import { DisputeRegistry } from "../src/DisputeRegistry.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert() external;
    function warp(uint256 timestamp) external;
}

contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 amount,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract MandateCourtTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant PRINCIPAL_KEY = 0xA11CE;
    uint256 private constant PROVIDER_KEY = 0xB0B;
    uint256 private constant COURT_KEY = 0xC0A7;
    address private principal;
    address private provider;
    address private court;
    MockUSDC private usdc;
    SettlementAdapter private adapter;
    MandateEscrow private escrow;
    MandateRegistry private registry;
    DisputeRegistry private disputes;
    bytes32 private constant MANDATE_ID = keccak256("MC-001");
    bytes32 private constant MANDATE_HASH = keccak256("mandate");
    bytes32 private constant POLICY_HASH = keccak256("RESEARCH_DATA_V1");

    function setUp() public {
        principal = vm.addr(PRINCIPAL_KEY);
        provider = vm.addr(PROVIDER_KEY);
        court = vm.addr(COURT_KEY);
        usdc = new MockUSDC();
        adapter = new SettlementAdapter(court);
        escrow = new MandateEscrow(address(usdc), address(adapter));
        registry = new MandateRegistry(court, address(escrow));
        disputes = new DisputeRegistry(court);
        adapter.setEscrow(address(escrow));
        adapter.setMandateRegistry(address(registry));
        adapter.setDisputeRegistry(address(disputes));
        escrow.setRegistry(address(registry));
        usdc.mint(principal, 100_000_000);
    }

    function testCreateAcceptSubmitAndPartialSettlement() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("delivery");
        _submit(deliveryHash);

        CourtTypes.FinalJudgment memory judgment = CourtTypes.FinalJudgment({
            mandateId: MANDATE_ID,
            mandateHash: MANDATE_HASH,
            deliveryHash: deliveryHash,
            genlayerTransactionId: keccak256("genlayer-tx"),
            verdictHash: keccak256("verdict"),
            providerBps: 8500,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        bytes memory signature = _signJudgment(judgment);
        _finalize(judgment);
        adapter.executeFinalJudgment(judgment, signature);

        _assertEq(usdc.balanceOf(provider), 17_000_000);
        _assertEq(usdc.balanceOf(principal), 83_000_000);
        _assertTrue(adapter.settled(MANDATE_ID));
    }

    function testDirectAssignmentRejectsWrongProvider() public {
        _create(provider);
        uint256 attackerKey = 0xBAD;
        address attacker = vm.addr(attackerKey);
        (
            CourtTypes.ActorIntent memory intent,
            CourtTypes.CourtAuthorization memory authorization
        ) = _intent(
            attacker, 0, 1, registry.ACCEPT_ACTION(), keccak256(abi.encode(MANDATE_ID, attacker))
        );
        bytes memory actorSig = _signIntent(attackerKey, intent);
        bytes memory courtSig = _signAuthorization(authorization);
        vm.expectRevert();
        registry.acceptMandate(intent, authorization, actorSig, courtSig);
    }

    function testPrincipalCanCancelUnacceptedMandateAndRecoverEscrow() public {
        _create(address(0));
        bytes32 payloadHash = keccak256(abi.encode(MANDATE_ID));
        (CourtTypes.ActorIntent memory intent, CourtTypes.CourtAuthorization memory authorization) =
            _intent(principal, 1, 1, registry.CANCEL_ACTION(), payloadHash);
        registry.cancelMandate(
            intent,
            authorization,
            _signIntent(PRINCIPAL_KEY, intent),
            _signAuthorization(authorization)
        );

        MandateRegistry.Mandate memory mandate = registry.getMandate(MANDATE_ID);
        _assertEq(uint256(mandate.status), uint256(CourtTypes.MandateStatus.Cancelled));
        _assertEq(usdc.balanceOf(principal), 100_000_000);
        bytes32 acceptPayloadHash = keccak256(abi.encode(MANDATE_ID, provider));
        (CourtTypes.ActorIntent memory acceptIntent, CourtTypes.CourtAuthorization memory acceptAuthorization) =
            _intent(provider, 0, 2, registry.ACCEPT_ACTION(), acceptPayloadHash);
        bytes memory acceptActorSignature = _signIntent(PROVIDER_KEY, acceptIntent);
        bytes memory acceptCourtSignature = _signAuthorization(acceptAuthorization);
        vm.expectRevert();
        registry.acceptMandate(
            acceptIntent, acceptAuthorization, acceptActorSignature, acceptCourtSignature
        );
    }

    function testExpiredActorAuthorizationReverts() public {
        uint64 acceptanceDeadline = uint64(block.timestamp + 1 days);
        uint64 deliveryDeadline = uint64(block.timestamp + 3 days);
        bytes32 payloadHash = keccak256(
            abi.encode(
                address(0),
                MANDATE_HASH,
                POLICY_HASH,
                uint256(20_000_000),
                acceptanceDeadline,
                deliveryDeadline
            )
        );
        (CourtTypes.ActorIntent memory intent, CourtTypes.CourtAuthorization memory authorization) =
            _intent(principal, 0, 0, registry.CREATE_ACTION(), payloadHash);
        intent.deadline = block.timestamp - 1;
        authorization.deadline = block.timestamp - 1;
        bytes memory actorSignature = _signIntent(PRINCIPAL_KEY, intent);
        bytes memory courtSignature = _signAuthorization(authorization);

        vm.expectRevert();
        registry.createMandate(
            intent,
            authorization,
            actorSignature,
            courtSignature,
            address(0),
            MANDATE_HASH,
            POLICY_HASH,
            20_000_000,
            acceptanceDeadline,
            deliveryDeadline,
            CourtTypes.FundingAuthorization({
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: keccak256("expired-funding"),
                v: 27,
                r: bytes32(uint256(1)),
                s: bytes32(uint256(2))
            })
        );
    }

    function testActorNonceReplayReverts() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("replayed-delivery");
        bytes32 payloadHash = keccak256(abi.encode(MANDATE_ID, deliveryHash));
        (CourtTypes.ActorIntent memory intent, CourtTypes.CourtAuthorization memory authorization) =
            _intent(provider, 0, 2, registry.SUBMIT_ACTION(), payloadHash);
        bytes memory actorSignature = _signIntent(PROVIDER_KEY, intent);
        bytes memory courtSignature = _signAuthorization(authorization);

        vm.expectRevert();
        registry.submitDelivery(
            intent,
            authorization,
            actorSignature,
            courtSignature,
            deliveryHash
        );
    }

    function testDuplicateSettlementReverts() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("delivery");
        _submit(deliveryHash);
        CourtTypes.FinalJudgment memory judgment = CourtTypes.FinalJudgment({
            mandateId: MANDATE_ID,
            mandateHash: MANDATE_HASH,
            deliveryHash: deliveryHash,
            genlayerTransactionId: keccak256("genlayer-tx"),
            verdictHash: keccak256("verdict"),
            providerBps: 10_000,
            nonce: 9,
            deadline: block.timestamp + 1 hours
        });
        bytes memory signature = _signJudgment(judgment);
        _finalize(judgment);
        adapter.executeFinalJudgment(judgment, signature);
        vm.expectRevert();
        adapter.executeFinalJudgment(judgment, signature);
    }

    function testSettlementRequiresFinalizedDisputeState() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("delivery");
        _submit(deliveryHash);
        CourtTypes.FinalJudgment memory judgment = _judgment(deliveryHash, 10_000, 10);
        bytes memory signature = _signJudgment(judgment);
        vm.expectRevert();
        adapter.executeFinalJudgment(judgment, signature);
    }

    function testSettlementRejectsCommitmentMismatch() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("delivery");
        _submit(deliveryHash);
        CourtTypes.FinalJudgment memory judgment = _judgment(deliveryHash, 10_000, 11);
        _finalize(judgment);
        judgment.deliveryHash = keccak256("wrong delivery");
        bytes memory signature = _signJudgment(judgment);
        vm.expectRevert();
        adapter.executeFinalJudgment(judgment, signature);
    }

    function testSettlementRejectsFinalVerdictMismatch() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("delivery");
        _submit(deliveryHash);
        CourtTypes.FinalJudgment memory judgment = _judgment(deliveryHash, 10_000, 12);
        _finalize(judgment);
        judgment.verdictHash = keccak256("wrong verdict");
        bytes memory signature = _signJudgment(judgment);
        vm.expectRevert();
        adapter.executeFinalJudgment(judgment, signature);
    }

    function testSettlementRejectsOutOfRangeProviderAward() public {
        _create(address(0));
        _accept();
        bytes32 deliveryHash = keccak256("delivery");
        _submit(deliveryHash);
        CourtTypes.FinalJudgment memory judgment = _judgment(deliveryHash, 10_001, 13);
        _finalize(judgment);
        bytes memory signature = _signJudgment(judgment);

        vm.expectRevert();
        adapter.executeFinalJudgment(judgment, signature);
    }

    function testOnlyCourtCanMutateDisputeState() public {
        vm.expectRevert();
        disputes.linkCase(MANDATE_ID, keccak256("unauthorized"));
    }

    function _judgment(bytes32 deliveryHash, uint16 providerBps, uint256 nonce)
        private
        view
        returns (CourtTypes.FinalJudgment memory)
    {
        return CourtTypes.FinalJudgment({
            mandateId: MANDATE_ID,
            mandateHash: MANDATE_HASH,
            deliveryHash: deliveryHash,
            genlayerTransactionId: keccak256("genlayer-tx"),
            verdictHash: keccak256("verdict"),
            providerBps: providerBps,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    function _finalize(CourtTypes.FinalJudgment memory judgment) private {
        vm.prank(court);
        disputes.linkCase(MANDATE_ID, judgment.genlayerTransactionId);
        vm.prank(court);
        disputes.recordFinalized(MANDATE_ID, judgment.verdictHash);
    }

    function testExpiredUnacceptedMandateRefundsPrincipal() public {
        _create(address(0));
        vm.warp(block.timestamp + 2 days);
        registry.markExpired(MANDATE_ID);
        _assertEq(usdc.balanceOf(principal), 100_000_000);
    }

    function testEachPartyGetsOneAppeal() public {
        bytes32 txId = keccak256("tx");
        vm.prank(court);
        disputes.linkCase(MANDATE_ID, txId);
        vm.prank(court);
        disputes.recordAppeal(MANDATE_ID, principal, true, keccak256("principal grounds"));
        vm.prank(court);
        disputes.recordAppeal(MANDATE_ID, provider, false, keccak256("provider grounds"));
        vm.prank(court);
        vm.expectRevert();
        disputes.recordAppeal(MANDATE_ID, principal, true, keccak256("again"));
    }

    function _create(address assignedProvider) private {
        uint64 acceptanceDeadline = uint64(block.timestamp + 1 days);
        uint64 deliveryDeadline = uint64(block.timestamp + 3 days);
        bytes32 payloadHash = keccak256(
            abi.encode(
                assignedProvider,
                MANDATE_HASH,
                POLICY_HASH,
                uint256(20_000_000),
                acceptanceDeadline,
                deliveryDeadline
            )
        );
        (CourtTypes.ActorIntent memory intent, CourtTypes.CourtAuthorization memory authorization) =
            _intent(principal, 0, 0, registry.CREATE_ACTION(), payloadHash);
        registry.createMandate(
            intent,
            authorization,
            _signIntent(PRINCIPAL_KEY, intent),
            _signAuthorization(authorization),
            assignedProvider,
            MANDATE_HASH,
            POLICY_HASH,
            20_000_000,
            acceptanceDeadline,
            deliveryDeadline,
            CourtTypes.FundingAuthorization({
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: keccak256("funding"),
                v: 27,
                r: bytes32(uint256(1)),
                s: bytes32(uint256(2))
            })
        );
    }

    function _accept() private {
        bytes32 payloadHash = keccak256(abi.encode(MANDATE_ID, provider));
        (CourtTypes.ActorIntent memory intent, CourtTypes.CourtAuthorization memory authorization) =
            _intent(provider, 0, 1, registry.ACCEPT_ACTION(), payloadHash);
        registry.acceptMandate(
            intent,
            authorization,
            _signIntent(PROVIDER_KEY, intent),
            _signAuthorization(authorization)
        );
    }

    function _submit(bytes32 deliveryHash) private {
        bytes32 payloadHash = keccak256(abi.encode(MANDATE_ID, deliveryHash));
        (CourtTypes.ActorIntent memory intent, CourtTypes.CourtAuthorization memory authorization) =
            _intent(provider, 1, 2, registry.SUBMIT_ACTION(), payloadHash);
        registry.submitDelivery(
            intent,
            authorization,
            _signIntent(PROVIDER_KEY, intent),
            _signAuthorization(authorization),
            deliveryHash
        );
    }

    function _intent(
        address actor,
        uint256 actorNonce,
        uint256 courtNonce,
        bytes32 action,
        bytes32 payloadHash
    ) private view returns (CourtTypes.ActorIntent memory, CourtTypes.CourtAuthorization memory) {
        CourtTypes.ActorIntent memory intent = CourtTypes.ActorIntent({
            mandateId: MANDATE_ID,
            action: action,
            payloadHash: payloadHash,
            actor: actor,
            nonce: actorNonce,
            deadline: block.timestamp + 1 hours
        });
        CourtTypes.CourtAuthorization memory authorization = CourtTypes.CourtAuthorization({
            mandateId: MANDATE_ID,
            action: action,
            payloadHash: payloadHash,
            actor: actor,
            actorNonce: actorNonce,
            courtNonce: courtNonce,
            deadline: block.timestamp + 1 hours
        });
        return (intent, authorization);
    }

    function _signIntent(uint256 key, CourtTypes.ActorIntent memory intent)
        private
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                registry.ACTOR_INTENT_TYPEHASH(),
                intent.mandateId,
                intent.action,
                intent.payloadHash,
                intent.actor,
                intent.nonce,
                intent.deadline
            )
        );
        return _signature(
            key, keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash))
        );
    }

    function _signAuthorization(CourtTypes.CourtAuthorization memory authorization)
        private
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                registry.COURT_AUTH_TYPEHASH(),
                authorization.mandateId,
                authorization.action,
                authorization.payloadHash,
                authorization.actor,
                authorization.actorNonce,
                authorization.courtNonce,
                authorization.deadline
            )
        );
        return _signature(
            COURT_KEY,
            keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash))
        );
    }

    function _signJudgment(CourtTypes.FinalJudgment memory judgment)
        private
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                adapter.FINAL_JUDGMENT_TYPEHASH(),
                judgment.mandateId,
                judgment.mandateHash,
                judgment.deliveryHash,
                judgment.genlayerTransactionId,
                judgment.verdictHash,
                judgment.providerBps,
                judgment.nonce,
                judgment.deadline
            )
        );
        return _signature(
            COURT_KEY,
            keccak256(abi.encodePacked("\x19\x01", adapter.domainSeparator(), structHash))
        );
    }

    function _signature(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assertEq(uint256 left, uint256 right) private pure {
        require(left == right, "not equal");
    }

    function _assertTrue(bool value) private pure {
        require(value, "not true");
    }
}
