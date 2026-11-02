// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

// HARNESS STUB — NOT part of the Lido repo. Served only to the solc import
// callback so that the REAL contracts/0.8.25/vaults/LazyOracle.sol compiles.
// Struct layouts are copied verbatim from the real VaultHub.sol.

import {DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "./lib/RefSlotCache.sol";

contract VaultHub {
    struct Report {
        uint104 totalValue;
        int104 inOutDelta;
        uint48 timestamp;
    }

    struct VaultRecord {
        Report report;
        uint96 maxLiabilityShares;
        uint96 liabilityShares;
        DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH] inOutDelta;
        uint128 minimalReserve;
        uint128 redemptionShares;
        uint128 cumulativeLidoFees;
        uint128 settledLidoFees;
    }

    struct VaultConnection {
        address owner;
        uint96 shareLimit;
        uint96 vaultIndex;
        uint48 disconnectInitiatedTs;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
        bool beaconChainDepositsPauseIntent;
    }

    struct Applied {
        address vault;
        uint256 reportTimestamp;
        uint256 totalValue;
        int256 inOutDelta;
        uint256 cumulativeLidoFees;
        uint256 liabilityShares;
        uint256 maxLiabilityShares;
        uint256 slashingReserve;
    }

    address public immutable lazyOracleAddr;
    mapping(address => VaultRecord) internal records;
    mapping(address => VaultConnection) internal conns;
    address[] internal vaultList;
    Applied[] public applied;

    constructor(address _lazyOracle) {
        lazyOracleAddr = _lazyOracle;
    }

    function appliedCount() external view returns (uint256) {
        return applied.length;
    }

    function seed(
        address _vault,
        uint104 _reportTotalValue,
        int104 _reportInOutDelta,
        uint48 _reportTimestamp,
        int104 _inOutDeltaCurrent,
        int104 _inOutDeltaOnRefSlot,
        uint48 _cacheRefSlot
    ) external {
        VaultRecord storage r = records[_vault];
        r.report = Report({
            totalValue: _reportTotalValue,
            inOutDelta: _reportInOutDelta,
            timestamp: _reportTimestamp
        });
        r.inOutDelta[0] = DoubleRefSlotCache.Int104WithCache({
            value: _inOutDeltaCurrent,
            valueOnRefSlot: _inOutDeltaOnRefSlot,
            refSlot: _cacheRefSlot
        });
        r.minimalReserve = 1 ether;
        if (conns[_vault].vaultIndex == 0) {
            vaultList.push(_vault);
            conns[_vault] = VaultConnection({
                owner: _vault,
                shareLimit: type(uint96).max,
                vaultIndex: uint96(vaultList.length),
                disconnectInitiatedTs: type(uint48).max,
                reserveRatioBP: 0,
                forcedRebalanceThresholdBP: 0,
                infraFeeBP: 0,
                liquidityFeeBP: 0,
                reservationFeeBP: 0,
                beaconChainDepositsPauseIntent: false
            });
        }
    }

    function setLiability(address _vault, uint96 _liability, uint96 _maxLiability) external {
        records[_vault].liabilityShares = _liability;
        records[_vault].maxLiabilityShares = _maxLiability;
    }

    function vaultRecord(address _vault) external view returns (VaultRecord memory) {
        return records[_vault];
    }

    function vaultConnection(address _vault) external view returns (VaultConnection memory) {
        return conns[_vault];
    }

    function vaultsCount() external view returns (uint256) {
        return vaultList.length;
    }

    function vaultByIndex(uint256 _index) external view returns (address) {
        return vaultList[_index - 1];
    }

    function isPendingDisconnect(address) external pure returns (bool) {
        return false;
    }

    function totalMintingCapacityShares(address, int256) external pure returns (uint256) {
        return 0;
    }

    function applyVaultReport(
        address _vault,
        uint256 _reportTimestamp,
        uint256 _reportTotalValue,
        int256 _reportInOutDelta,
        uint256 _reportCumulativeLidoFees,
        uint256 _reportLiabilityShares,
        uint256 _reportMaxLiabilityShares,
        uint256 _reportSlashingReserve
    ) external {
        require(msg.sender == lazyOracleAddr, "STUB: only lazyOracle");
        VaultRecord storage r = records[_vault];
        r.report = Report({
            totalValue: uint104(_reportTotalValue),
            inOutDelta: int104(_reportInOutDelta),
            timestamp: uint48(_reportTimestamp)
        });
        r.cumulativeLidoFees = uint128(_reportCumulativeLidoFees);
        r.liabilityShares = uint96(_reportLiabilityShares);
        r.maxLiabilityShares = uint96(_reportMaxLiabilityShares);
        r.minimalReserve = uint128(_reportSlashingReserve);
        applied.push(
            Applied({
                vault: _vault,
                reportTimestamp: _reportTimestamp,
                totalValue: _reportTotalValue,
                inOutDelta: _reportInOutDelta,
                cumulativeLidoFees: _reportCumulativeLidoFees,
                liabilityShares: _reportLiabilityShares,
                maxLiabilityShares: _reportMaxLiabilityShares,
                slashingReserve: _reportSlashingReserve
            })
        );
    }
}
