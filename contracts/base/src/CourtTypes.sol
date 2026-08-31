// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

library CourtTypes {
    enum MandateStatus {
        None,
        Funded,
        Offered,
        Active,
        Submitted,
        UnderReview,
        Finalized,
        Settled,
        Cancelled,
        Expired
    }

    struct ActorIntent {
        bytes32 mandateId;
        bytes32 action;
        bytes32 payloadHash;
        address actor;
        uint256 nonce;
        uint256 deadline;
    }

    struct CourtAuthorization {
        bytes32 mandateId;
        bytes32 action;
        bytes32 payloadHash;
        address actor;
        uint256 actorNonce;
        uint256 courtNonce;
        uint256 deadline;
    }

    struct FinalJudgment {
        bytes32 mandateId;
        bytes32 mandateHash;
        bytes32 deliveryHash;
        bytes32 genlayerTransactionId;
        bytes32 verdictHash;
        uint16 providerBps;
        uint256 nonce;
        uint256 deadline;
    }

    struct FundingAuthorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }
}
