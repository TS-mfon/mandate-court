// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { CourtTypes } from "./CourtTypes.sol";

interface IERC20Escrow {
    function transfer(address to, uint256 amount) external returns (bool);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IMandateRegistryEscrow {
    function setStatus(bytes32 mandateId, CourtTypes.MandateStatus status) external;
}

contract MandateEscrow {
    struct Deposit {
        address principal;
        address provider;
        uint256 amount;
        bool funded;
        bool settled;
    }

    IERC20Escrow public immutable usdc;
    address public immutable settlementAdapter;
    address public immutable owner;
    address public registry;
    mapping(bytes32 => Deposit) public deposits;
    uint256 private locked = 1;

    event EscrowFunded(bytes32 indexed mandateId, address indexed principal, uint256 amount);
    event ProviderBound(bytes32 indexed mandateId, address indexed provider);
    event EscrowSettled(
        bytes32 indexed mandateId,
        uint16 providerBps,
        uint256 providerAmount,
        uint256 principalRefund
    );
    event EscrowRefunded(bytes32 indexed mandateId, uint256 amount);

    constructor(address usdc_, address settlementAdapter_) {
        if (usdc_ == address(0) || settlementAdapter_ == address(0)) revert ZeroAddress();
        usdc = IERC20Escrow(usdc_);
        settlementAdapter = settlementAdapter_;
        owner = msg.sender;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    function setRegistry(address registry_) external {
        if (msg.sender != owner || registry != address(0) || registry_ == address(0)) {
            revert Unauthorized();
        }
        registry = registry_;
    }

    function fund(
        bytes32 mandateId,
        address principal,
        uint256 amount,
        CourtTypes.FundingAuthorization calldata authorization
    ) external nonReentrant {
        if (msg.sender != registry) {
            revert Unauthorized();
        }
        if (deposits[mandateId].funded || amount == 0) revert InvalidDeposit();
        deposits[mandateId] = Deposit(principal, address(0), amount, true, false);
        usdc.receiveWithAuthorization(
            principal,
            address(this),
            amount,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            authorization.v,
            authorization.r,
            authorization.s
        );
        emit EscrowFunded(mandateId, principal, amount);
    }

    function bindProvider(bytes32 mandateId, address provider) external {
        if (msg.sender != registry || provider == address(0)) revert Unauthorized();
        Deposit storage deposit = deposits[mandateId];
        if (!deposit.funded || deposit.provider != address(0)) revert InvalidDeposit();
        deposit.provider = provider;
        emit ProviderBound(mandateId, provider);
    }

    function settle(bytes32 mandateId, uint16 providerBps) external nonReentrant {
        if (msg.sender != settlementAdapter) revert Unauthorized();
        if (providerBps > 10_000) revert InvalidBps();
        Deposit storage deposit = deposits[mandateId];
        if (!deposit.funded || deposit.settled || deposit.provider == address(0)) {
            revert InvalidDeposit();
        }
        deposit.settled = true;
        uint256 providerAmount = deposit.amount * providerBps / 10_000;
        uint256 principalRefund = deposit.amount - providerAmount;
        if (providerAmount != 0 && !usdc.transfer(deposit.provider, providerAmount)) {
            revert TransferFailed();
        }
        if (principalRefund != 0 && !usdc.transfer(deposit.principal, principalRefund)) {
            revert TransferFailed();
        }
        if (registry != address(0)) {
            IMandateRegistryEscrow(registry).setStatus(mandateId, CourtTypes.MandateStatus.Settled);
        }
        emit EscrowSettled(mandateId, providerBps, providerAmount, principalRefund);
    }

    function refund(bytes32 mandateId) external nonReentrant {
        if (msg.sender != registry) revert Unauthorized();
        Deposit storage deposit = deposits[mandateId];
        if (!deposit.funded || deposit.settled) revert InvalidDeposit();
        deposit.settled = true;
        if (!usdc.transfer(deposit.principal, deposit.amount)) revert TransferFailed();
        emit EscrowRefunded(mandateId, deposit.amount);
    }

    error InvalidBps();
    error InvalidDeposit();
    error Reentrancy();
    error TransferFailed();
    error Unauthorized();
    error ZeroAddress();
}
