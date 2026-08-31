// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

contract DisputeRegistry {
    struct CaseRecord {
        bytes32 genlayerTransactionId;
        bytes32 acceptedVerdictHash;
        bytes32 finalizedVerdictHash;
        bytes32 principalAppealHash;
        bytes32 providerAppealHash;
        bool principalAppealed;
        bool providerAppealed;
        bool finalized;
    }

    address public immutable courtSigner;
    mapping(bytes32 => CaseRecord) private cases;

    event CaseLinked(bytes32 indexed mandateId, bytes32 indexed genlayerTransactionId);
    event VerdictAccepted(bytes32 indexed mandateId, bytes32 indexed verdictHash);
    event AppealRecorded(bytes32 indexed mandateId, address indexed appellant, bytes32 groundsHash);
    event VerdictFinalized(bytes32 indexed mandateId, bytes32 indexed verdictHash);

    constructor(address courtSigner_) {
        if (courtSigner_ == address(0)) revert ZeroAddress();
        courtSigner = courtSigner_;
    }

    modifier onlyCourt() {
        if (msg.sender != courtSigner) revert Unauthorized();
        _;
    }

    function linkCase(bytes32 mandateId, bytes32 transactionId) external onlyCourt {
        CaseRecord storage record = cases[mandateId];
        if (record.genlayerTransactionId != bytes32(0)) revert CaseExists();
        record.genlayerTransactionId = transactionId;
        emit CaseLinked(mandateId, transactionId);
    }

    function recordAccepted(bytes32 mandateId, bytes32 verdictHash) external onlyCourt {
        CaseRecord storage record = _case(mandateId);
        if (record.finalized) revert AlreadyFinalized();
        record.acceptedVerdictHash = verdictHash;
        emit VerdictAccepted(mandateId, verdictHash);
    }

    function recordAppeal(bytes32 mandateId, address appellant, bool principal, bytes32 groundsHash)
        external
        onlyCourt
    {
        CaseRecord storage record = _case(mandateId);
        if (record.finalized || groundsHash == bytes32(0)) revert InvalidAppeal();
        if (principal) {
            if (record.principalAppealed) revert AppealAlreadyUsed();
            record.principalAppealed = true;
            record.principalAppealHash = groundsHash;
        } else {
            if (record.providerAppealed) revert AppealAlreadyUsed();
            record.providerAppealed = true;
            record.providerAppealHash = groundsHash;
        }
        emit AppealRecorded(mandateId, appellant, groundsHash);
    }

    function recordFinalized(bytes32 mandateId, bytes32 verdictHash) external onlyCourt {
        CaseRecord storage record = _case(mandateId);
        if (record.finalized) revert AlreadyFinalized();
        record.finalized = true;
        record.finalizedVerdictHash = verdictHash;
        emit VerdictFinalized(mandateId, verdictHash);
    }

    function getCase(bytes32 mandateId) external view returns (CaseRecord memory) {
        return _case(mandateId);
    }

    function _case(bytes32 mandateId) private view returns (CaseRecord storage record) {
        record = cases[mandateId];
        if (record.genlayerTransactionId == bytes32(0)) revert UnknownCase();
    }

    error AlreadyFinalized();
    error AppealAlreadyUsed();
    error CaseExists();
    error InvalidAppeal();
    error Unauthorized();
    error UnknownCase();
    error ZeroAddress();
}
