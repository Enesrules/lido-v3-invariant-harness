// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.25;

/// @dev test-only minimal ERC1967 proxy (harness scaffolding, not Lido source)
contract TinyProxy {
    bytes32 private constant IMPL_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    constructor(address _impl) {
        bytes32 s = IMPL_SLOT;
        assembly {
            sstore(s, _impl)
        }
    }

    fallback() external payable {
        bytes32 s = IMPL_SLOT;
        address impl;
        assembly {
            impl := sload(s)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    receive() external payable {}
}
