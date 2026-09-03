// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { CourtTypes } from "./CourtTypes.sol";
import { SignatureVerifier } from "./SignatureVerifier.sol";

interface IMandateEscrowSettlement {
    function settle(bytes32 mandateId, uint16 providerBps) external;
}

interface IMandateRegistrySettlement {
    function getMandate(bytes32 mandateId)
        external
        view
        returns (
            address principal,
            address provider,
            bytes32 mandateHash,
            bytes32 policyHash,
            bytes32 deliveryHash,
            uint256 amount,
            uint64 acceptanceDeadline,
            uint64 deliveryDeadline,
            CourtTypes.MandateStatus status
        );
}

interface IDisputeRegistrySettlement {
    function getCase(bytes32 mandateId)
        external
        view
        returns (
            bytes32 genlayerTransactionId,
            bytes32 acceptedVerdictHash,
            bytes32 finalizedVerdictHash,
            bytes32 principalAppealHash,
            bytes32 providerAppealHash,
            bool principalAppealed,
            bool providerAppealed,
            bool finalized
        );
}

contract SettlementAdapter is SignatureVerifier {
    bytes32 public constant FINAL_JUDGMENT_TYPEHASH = keccak256(
        "FinalJudgment(bytes32 mandateId,bytes32 mandateHash,bytes32 deliveryHash,bytes32 genlayerTransactionId,bytes32 verdictHash,uint16 providerBps,uint256 nonce,uint256 deadline)"
    );

    address public immutable courtAttestor;
    address public immutable owner;
    IMandateEscrowSettlement public escrow;
    IMandateRegistrySettlement public mandateRegistry;
    IDisputeRegistrySettlement public disputeRegistry;
    mapping(bytes32 => bool) public settled;
    mapping(uint256 => bool) public usedNonces;

    event FinalJudgmentExecuted(
        bytes32 indexed mandateId,
        bytes32 indexed genlayerTransactionId,
        bytes32 indexed verdictHash,
        uint16 providerBps,
        uint256 nonce
    );

    constructor(address courtAttestor_) SignatureVerifier("Mandate Court Final Judgment", "1") {
        if (courtAttestor_ == address(0)) revert ZeroAddress();
        courtAttestor = courtAttestor_;
        owner = msg.sender;
    }

    function setEscrow(address escrow_) external {
        if (msg.sender != owner || address(escrow) != address(0) || escrow_ == address(0)) {
            revert Unauthorized();
        }
        escrow = IMandateEscrowSettlement(escrow_);
    }

    function setMandateRegistry(address registry_) external {
        if (
            msg.sender != owner || address(mandateRegistry) != address(0) || registry_ == address(0)
        ) {
            revert Unauthorized();
        }
        mandateRegistry = IMandateRegistrySettlement(registry_);
    }

    function setDisputeRegistry(address registry_) external {
        if (
            msg.sender != owner || address(disputeRegistry) != address(0) || registry_ == address(0)
        ) {
            revert Unauthorized();
        }
        disputeRegistry = IDisputeRegistrySettlement(registry_);
    }

    function executeFinalJudgment(
        CourtTypes.FinalJudgment calldata judgment,
        bytes calldata attestation
    ) external {
        if (address(escrow) == address(0)) {
            revert EscrowNotConfigured();
        }
        if (address(mandateRegistry) == address(0) || address(disputeRegistry) == address(0)) {
            revert CourtStateNotConfigured();
        }
        if (judgment.deadline < block.timestamp) revert AuthorizationExpired();
        if (judgment.providerBps > 10_000) revert InvalidBps();
        if (settled[judgment.mandateId] || usedNonces[judgment.nonce]) revert Replay();
        bytes32 digest = _hashTypedData(
            keccak256(
                abi.encode(
                    FINAL_JUDGMENT_TYPEHASH,
                    judgment.mandateId,
                    judgment.mandateHash,
                    judgment.deliveryHash,
                    judgment.genlayerTransactionId,
                    judgment.verdictHash,
                    judgment.providerBps,
                    judgment.nonce,
                    judgment.deadline
                )
            )
        );
        if (_recover(digest, attestation) != courtAttestor) revert InvalidSignature();
        (,, bytes32 canonicalMandateHash,, bytes32 canonicalDeliveryHash,,,,) =
            mandateRegistry.getMandate(judgment.mandateId);
        if (
            canonicalMandateHash != judgment.mandateHash
                || canonicalDeliveryHash != judgment.deliveryHash
        ) {
            revert CommitmentMismatch();
        }
        (bytes32 linkedTransactionId,, bytes32 finalizedVerdictHash,,,,, bool finalized) =
            disputeRegistry.getCase(judgment.mandateId);
        if (
            !finalized || linkedTransactionId != judgment.genlayerTransactionId
                || finalizedVerdictHash != judgment.verdictHash
        ) {
            revert JudgmentNotFinal();
        }
        settled[judgment.mandateId] = true;
        usedNonces[judgment.nonce] = true;
        escrow.settle(judgment.mandateId, judgment.providerBps);
        emit FinalJudgmentExecuted(
            judgment.mandateId,
            judgment.genlayerTransactionId,
            judgment.verdictHash,
            judgment.providerBps,
            judgment.nonce
        );
    }

    error AuthorizationExpired();
    error EscrowNotConfigured();
    error CourtStateNotConfigured();
    error CommitmentMismatch();
    error JudgmentNotFinal();
    error InvalidBps();
    error Replay();
    error Unauthorized();
    error ZeroAddress();
}
