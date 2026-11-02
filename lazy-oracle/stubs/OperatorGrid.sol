// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

// HARNESS STUB — only needed so the REAL LazyOracle.sol compiles
// (it imports OperatorGrid for its return type).
contract OperatorGrid {
    function effectiveShareLimit(address) external pure returns (uint256) {
        return type(uint256).max;
    }
}
