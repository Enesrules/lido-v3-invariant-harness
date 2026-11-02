// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

// HARNESS helper: ERC1967 proxy so the real LazyOracle implementation can be initialized.
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";

contract HarnessProxy is ERC1967Proxy {
    constructor(address _impl, bytes memory _data) ERC1967Proxy(_impl, _data) {}
}
