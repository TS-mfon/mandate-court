// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract SignatureVerifier {
    bytes32 internal immutable DOMAIN_SEPARATOR;
    uint256 internal immutable INITIAL_CHAIN_ID;
    bytes32 internal immutable NAME_HASH;
    bytes32 internal immutable VERSION_HASH;

    bytes32 internal constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    constructor(string memory name, string memory version) {
        INITIAL_CHAIN_ID = block.chainid;
        NAME_HASH = keccak256(bytes(name));
        VERSION_HASH = keccak256(bytes(version));
        DOMAIN_SEPARATOR = _computeDomainSeparator(name, version);
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == INITIAL_CHAIN_ID
            ? DOMAIN_SEPARATOR
            : keccak256(
                abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
            );
    }

    function _computeDomainSeparator(string memory name, string memory version)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) {
            revert InvalidSignature();
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }

    error InvalidSignature();
}
