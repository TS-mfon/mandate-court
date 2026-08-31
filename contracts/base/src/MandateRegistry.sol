// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { CourtTypes } from "./CourtTypes.sol";
import { SignatureVerifier } from "./SignatureVerifier.sol";

interface IMandateEscrowRegistry {
    function fund(
        bytes32 mandateId,
        address principal,
        uint256 amount,
        CourtTypes.FundingAuthorization calldata authorization
    ) external;
    function bindProvider(bytes32 mandateId, address provider) external;
    function refund(bytes32 mandateId) external;
}

contract MandateRegistry is SignatureVerifier {
    bytes32 public constant CREATE_ACTION = keccak256("CREATE_MANDATE");
    bytes32 public constant ACCEPT_ACTION = keccak256("ACCEPT_MANDATE");
    bytes32 public constant SUBMIT_ACTION = keccak256("SUBMIT_DELIVERY");
    bytes32 public constant CANCEL_ACTION = keccak256("CANCEL_MANDATE");

    bytes32 public constant ACTOR_INTENT_TYPEHASH = keccak256(
        "ActorIntent(bytes32 mandateId,bytes32 action,bytes32 payloadHash,address actor,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant COURT_AUTH_TYPEHASH = keccak256(
        "CourtAuthorization(bytes32 mandateId,bytes32 action,bytes32 payloadHash,address actor,uint256 actorNonce,uint256 courtNonce,uint256 deadline)"
    );

    struct Mandate {
        address principal;
        address provider;
        bytes32 mandateHash;
        bytes32 policyHash;
        bytes32 deliveryHash;
        uint256 amount;
        uint64 acceptanceDeadline;
        uint64 deliveryDeadline;
        CourtTypes.MandateStatus status;
    }

    address public immutable courtSigner;
    IMandateEscrowRegistry public immutable escrow;
    mapping(bytes32 => Mandate) private mandates;
    mapping(address => uint256) public actorNonces;
    uint256 public courtNonce;

    event MandateCreated(
        bytes32 indexed mandateId,
        address indexed principal,
        address indexed provider,
        bytes32 mandateHash,
        bytes32 policyHash,
        uint256 amount
    );
    event MandateAccepted(bytes32 indexed mandateId, address indexed provider);
    event DeliverySubmitted(bytes32 indexed mandateId, bytes32 indexed deliveryHash);
    event MandateCancelled(bytes32 indexed mandateId);
    event MandateExpired(bytes32 indexed mandateId);
    event MandateStatusChanged(bytes32 indexed mandateId, CourtTypes.MandateStatus status);

    constructor(address courtSigner_, address escrow_) SignatureVerifier("Mandate Court", "1") {
        if (courtSigner_ == address(0) || escrow_ == address(0)) revert ZeroAddress();
        courtSigner = courtSigner_;
        escrow = IMandateEscrowRegistry(escrow_);
    }

    function createMandate(
        CourtTypes.ActorIntent calldata actorIntent,
        CourtTypes.CourtAuthorization calldata courtAuthorization,
        bytes calldata actorSignature,
        bytes calldata courtSignature,
        address provider,
        bytes32 mandateHash,
        bytes32 policyHash,
        uint256 amount,
        uint64 acceptanceDeadline,
        uint64 deliveryDeadline,
        CourtTypes.FundingAuthorization calldata fundingAuthorization
    ) external {
        if (mandates[actorIntent.mandateId].status != CourtTypes.MandateStatus.None) {
            revert MandateExists();
        }
        if (
            amount == 0 || acceptanceDeadline <= block.timestamp
                || deliveryDeadline <= acceptanceDeadline
        ) {
            revert InvalidMandate();
        }
        bytes32 payloadHash = keccak256(
            abi.encode(
                provider, mandateHash, policyHash, amount, acceptanceDeadline, deliveryDeadline
            )
        );
        _authorize(
            actorIntent,
            courtAuthorization,
            CREATE_ACTION,
            payloadHash,
            actorSignature,
            courtSignature
        );
        mandates[actorIntent.mandateId] = Mandate({
            principal: actorIntent.actor,
            provider: provider,
            mandateHash: mandateHash,
            policyHash: policyHash,
            deliveryHash: bytes32(0),
            amount: amount,
            acceptanceDeadline: acceptanceDeadline,
            deliveryDeadline: deliveryDeadline,
            status: CourtTypes.MandateStatus.Funded
        });
        escrow.fund(actorIntent.mandateId, actorIntent.actor, amount, fundingAuthorization);
        emit MandateCreated(
            actorIntent.mandateId, actorIntent.actor, provider, mandateHash, policyHash, amount
        );
    }

    function acceptMandate(
        CourtTypes.ActorIntent calldata actorIntent,
        CourtTypes.CourtAuthorization calldata courtAuthorization,
        bytes calldata actorSignature,
        bytes calldata courtSignature
    ) external {
        Mandate storage mandate = _mandate(actorIntent.mandateId);
        if (mandate.status != CourtTypes.MandateStatus.Funded) revert InvalidStatus();
        if (block.timestamp > mandate.acceptanceDeadline) revert DeadlinePassed();
        if (mandate.provider != address(0) && mandate.provider != actorIntent.actor) {
            revert WrongProvider();
        }
        bytes32 payloadHash = keccak256(abi.encode(actorIntent.mandateId, actorIntent.actor));
        _authorize(
            actorIntent,
            courtAuthorization,
            ACCEPT_ACTION,
            payloadHash,
            actorSignature,
            courtSignature
        );
        mandate.provider = actorIntent.actor;
        mandate.status = CourtTypes.MandateStatus.Active;
        escrow.bindProvider(actorIntent.mandateId, actorIntent.actor);
        emit MandateAccepted(actorIntent.mandateId, actorIntent.actor);
    }

    function submitDelivery(
        CourtTypes.ActorIntent calldata actorIntent,
        CourtTypes.CourtAuthorization calldata courtAuthorization,
        bytes calldata actorSignature,
        bytes calldata courtSignature,
        bytes32 deliveryHash
    ) external {
        Mandate storage mandate = _mandate(actorIntent.mandateId);
        if (mandate.status != CourtTypes.MandateStatus.Active) revert InvalidStatus();
        if (mandate.provider != actorIntent.actor) revert WrongProvider();
        if (block.timestamp > mandate.deliveryDeadline) revert DeadlinePassed();
        bytes32 payloadHash = keccak256(abi.encode(actorIntent.mandateId, deliveryHash));
        _authorize(
            actorIntent,
            courtAuthorization,
            SUBMIT_ACTION,
            payloadHash,
            actorSignature,
            courtSignature
        );
        mandate.deliveryHash = deliveryHash;
        mandate.status = CourtTypes.MandateStatus.Submitted;
        emit DeliverySubmitted(actorIntent.mandateId, deliveryHash);
    }

    function cancelMandate(
        CourtTypes.ActorIntent calldata actorIntent,
        CourtTypes.CourtAuthorization calldata courtAuthorization,
        bytes calldata actorSignature,
        bytes calldata courtSignature
    ) external {
        Mandate storage mandate = _mandate(actorIntent.mandateId);
        if (mandate.principal != actorIntent.actor) revert WrongPrincipal();
        if (mandate.status != CourtTypes.MandateStatus.Funded) revert InvalidStatus();
        bytes32 payloadHash = keccak256(abi.encode(actorIntent.mandateId));
        _authorize(
            actorIntent,
            courtAuthorization,
            CANCEL_ACTION,
            payloadHash,
            actorSignature,
            courtSignature
        );
        mandate.status = CourtTypes.MandateStatus.Cancelled;
        escrow.refund(actorIntent.mandateId);
        emit MandateCancelled(actorIntent.mandateId);
    }

    function markExpired(bytes32 mandateId) external {
        Mandate storage mandate = _mandate(mandateId);
        bool acceptanceExpired = mandate.status == CourtTypes.MandateStatus.Funded
            && block.timestamp > mandate.acceptanceDeadline;
        bool deliveryExpired = mandate.status == CourtTypes.MandateStatus.Active
            && block.timestamp > mandate.deliveryDeadline;
        if (!acceptanceExpired && !deliveryExpired) revert NotExpired();
        mandate.status = CourtTypes.MandateStatus.Expired;
        escrow.refund(mandateId);
        emit MandateExpired(mandateId);
    }

    function setStatus(bytes32 mandateId, CourtTypes.MandateStatus status) external {
        if (msg.sender != address(escrow)) revert Unauthorized();
        Mandate storage mandate = _mandate(mandateId);
        mandate.status = status;
        emit MandateStatusChanged(mandateId, status);
    }

    function getMandate(bytes32 mandateId) external view returns (Mandate memory) {
        return _mandate(mandateId);
    }

    function _authorize(
        CourtTypes.ActorIntent calldata actorIntent,
        CourtTypes.CourtAuthorization calldata courtAuthorization,
        bytes32 expectedAction,
        bytes32 expectedPayloadHash,
        bytes calldata actorSignature,
        bytes calldata courtSignature
    ) private {
        if (actorIntent.deadline < block.timestamp || courtAuthorization.deadline < block.timestamp)
        {
            revert AuthorizationExpired();
        }
        if (
            actorIntent.action != expectedAction || actorIntent.payloadHash != expectedPayloadHash
                || courtAuthorization.action != expectedAction
                || courtAuthorization.payloadHash != expectedPayloadHash
                || courtAuthorization.mandateId != actorIntent.mandateId
                || courtAuthorization.actor != actorIntent.actor
                || courtAuthorization.actorNonce != actorIntent.nonce
        ) revert AuthorizationMismatch();
        if (actorIntent.nonce != actorNonces[actorIntent.actor]++) revert InvalidNonce();
        if (courtAuthorization.courtNonce != courtNonce++) revert InvalidNonce();
        bytes32 actorDigest = _hashTypedData(
            keccak256(
                abi.encode(
                    ACTOR_INTENT_TYPEHASH,
                    actorIntent.mandateId,
                    actorIntent.action,
                    actorIntent.payloadHash,
                    actorIntent.actor,
                    actorIntent.nonce,
                    actorIntent.deadline
                )
            )
        );
        bytes32 courtDigest = _hashTypedData(
            keccak256(
                abi.encode(
                    COURT_AUTH_TYPEHASH,
                    courtAuthorization.mandateId,
                    courtAuthorization.action,
                    courtAuthorization.payloadHash,
                    courtAuthorization.actor,
                    courtAuthorization.actorNonce,
                    courtAuthorization.courtNonce,
                    courtAuthorization.deadline
                )
            )
        );
        if (_recover(actorDigest, actorSignature) != actorIntent.actor) revert InvalidSignature();
        if (_recover(courtDigest, courtSignature) != courtSigner) revert InvalidSignature();
    }

    function _mandate(bytes32 mandateId) private view returns (Mandate storage mandate) {
        mandate = mandates[mandateId];
        if (mandate.status == CourtTypes.MandateStatus.None) revert UnknownMandate();
    }

    error AuthorizationExpired();
    error AuthorizationMismatch();
    error DeadlinePassed();
    error InvalidMandate();
    error InvalidNonce();
    error InvalidStatus();
    error MandateExists();
    error NotExpired();
    error Unauthorized();
    error UnknownMandate();
    error WrongPrincipal();
    error WrongProvider();
    error ZeroAddress();
}
