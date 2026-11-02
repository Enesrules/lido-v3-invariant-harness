// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

// HARNESS mock for LidoLocator (returns the addresses LazyOracle reads).
contract MockLocator {
    address public vaultHub;
    address public accountingOracle;
    address public operatorGrid;
    address public lido;
    address public predepositGuarantee;

    function set(address _vaultHub, address _accountingOracle, address _operatorGrid, address _lido) external {
        vaultHub = _vaultHub;
        accountingOracle = _accountingOracle;
        operatorGrid = _operatorGrid;
        lido = _lido;
    }

    function setPDG(address _pdg) external {
        predepositGuarantee = _pdg;
    }
}
