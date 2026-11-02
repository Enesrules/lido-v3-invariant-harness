# Lido V3 vault accounting-invariant hunt — verdict: NO_FINDING

Repo: `~/.hermes/cache/scratch/lido/repo` @ HEAD `2bd5322` (contracts: `0.8.25/vaults/*`).
Harness: this directory. Real source, real bytecode, local EVM only (no mainnet interaction).

## Verdict

No fund-affecting invariant violation found. One **behavioural observation** on
`LazyOracle.quarantineValue()` accounting (documented below) — view-only, no value impact, not
submittable as Medium/High on the Lido Immunefi program.

## What was executed (not just read)

`compile.js` compiles the **unmodified** `contracts/0.8.25/vaults/LazyOracle.sol` (and its in-repo
graph, incl. `lib/RefSlotCache.sol`, `contracts/openzeppelin/5.2/upgradeable/*`) with solc 0.8.25.
Only two dependencies are shadowed for the import callback, both layout-verbatim stubs:

* `stubs/VaultHub.sol` — `Report` / `VaultRecord` / `VaultConnection` structs copied verbatim from
  the real `VaultHub.sol`; implements `vaultRecord`, `vaultConnection`, `applyVaultReport`
  (records the applied report like the real one), `vaultsCount`, `vaultByIndex`.
* `stubs/OperatorGrid.sol` — empty (LazyOracle only uses the type).

`run.js` deploys the real `LazyOracle` behind an ERC1967 proxy (`HarnessProxy.sol`), wires a
`MockLocator`, publishes a single-leaf Merkle root per round via `updateReportData` (authorised
accounting-oracle account) and then applies reports permissionlessly through
`updateVaultData(...)` exactly as a stranger would.

Run: `node compile.js contracts/0.8.25/vaults/LazyOracle.sol MockLocator.sol HarnessProxy.sol && node run.js`

### Result (last clean run)

```
rounds 744, sequences 154, quarantines entered 651, violations 0
RESULT: ALL INVARIANTS HELD
```

Invariants exercised, with the concrete reason each held:

| # | Invariant | Result / reason it holds |
|---|---|---|
| I1 | applied totalValue ≤ reported totalValue for the same round | 0 violations / 744 rounds. `_processTotalValue` (LazyOracle.sol:505) returns either `_reportedTotalValue` (accept path) or `onchainTotalValueOnRefSlot` / `onchain+quarantinedValue` (hold path). The hold-path return is always `≤ reported`, because `onchain+Q ≤ thresholdWithRewards < reported` is exactly the branch condition. |
| I2 | applied totalValue never exceeds the max ever reported | 0 violations. Monotone: every branch's return value is bounded by a reported value seen so far; quarantine release re-credits a previously *reported* increment, never a new one. |
| I3 | increase is never credited before `startTimestamp + quarantinePeriod` | Sequence A: 100→150 ETH jump stays at applied=100 for 2 rounds, applied=100 (old Q released) at +90,000 s, applied=150 at +180,000 s. Expiry is read from the *report* timestamp (`_determineQuarantineState`, LazyOracle.sol:590), which is global oracle data, so a vault owner cannot advance it. |
| I4 | value credited in a round ≤ reported delta + previously pending | 0 violations / 744 rounds (the "no double release" check across expiry transitions). |
| I5 | +X% ratchet cannot smuggle value past quarantine | Sequence B: compounding +4%/round (below the 500 bp `maxRewardRatioBP`) with the applied base stuck at 0 left applied=0 for all 6 rounds; the threshold is computed off `onchainTotalValueOnRefSlot`, i.e. off what was actually applied, so a held base keeps every later report above threshold. |

Sequences C/D cover the two non-obvious transitions (`QUARANTINE_ACTIVE → NO_QUARANTINE` early
release on a drop, and `QUARANTINE_EXPIRED → QUARANTINE_ACTIVE` release-old/queue-new); both stayed
≤ reported.

## Observation (informational, not a finding)

`Quarantine.pendingTotalValueIncrease` is never reduced while a quarantine is *maintained*, only
overwritten at start, so `quarantineValue()`/`vaultInfo()` can report a pending amount larger than
`reportedTotalValue - appliedTotalValue` (134 of 744 rounds in the fuzz run; reproduced in
sequence R0). Consequences checked:

* it does **not** affect the value credited to the vault (I1/I4 held throughout);
* it does widen the release test `threshold + Q*(1+r)` in the EXPIRED branch, so a larger single
  jump can be accepted at expiry — but the accepted amount is still bounded by the oracle-reported
  total value, so no unbacked value is credited.

Impact = misleading view / dashboard number only. Not submittable as Medium+ under the Lido program
(no impact on funds, no privileged-path bypass).

## VaultHub-side invariants: checked by inspection, not by harness

Not executed end-to-end (would need the full VaultHub/StakingVault graph; VaultHub requires
`via_ir` under the repo's `vaultHub` profile, which was out of budget). Each held for a concrete,
cited reason:

* **Withdrawal cannot strip the reserve behind liabilityShares** — `withdraw` (VaultHub.sol:744) is
  capped by `_withdrawableValue` → `_withdrawableValueFeesIncluded` (1452) =
  `min(availableBalance, totalValue)` − redemptionValue, then `min(..., _unlocked)` where
  `_unlocked = totalValue − _locked(liabilityShares)`; `_withdraw` (1147) additionally rejects
  `_amount > _totalValue`. Frozen-report attack surface is closed by `_requireFreshReport`.
* **Mint cannot exceed reserve/limit** — `_increaseLiability` (1158) enforces
  `sharesAfterMint ≤ shareLimit` and `etherToLock ≤ _maxLockableValue` (1494, totalValue net of
  unsettled fees); `maxLiabilityShares` only ratchets up, and `_applyVaultReport` refreshes it only
  when it equals the report's value, so a stale report cannot unlock a higher lock basis.
* **Report fields cannot truncate** — `Report.totalValue` is `uint104` while LazyOracle rejects
  `> type(uint96).max` (LazyOracle.sol:137, 512); `cumulativeLidoFees`/`minimalReserve`/
  `maxLiabilityShares` use `SafeCast` since `702ef9d`; `report.inOutDelta` is oracle-supplied and
  not attacker-steerable (owner can only change it through `fund`/`withdraw`, which move ETH).
* **Value-moving entry points are all gated or bounded** — `socializeBadDebt`, `internalizeBadDebt`
  (BAD_DEBT_MASTER_ROLE), `decreaseInternalizedBadDebt` (accounting only),
  `setLiabilitySharesTarget` (REDEMPTION_MASTER_ROLE), `forceValidatorExit` (VALIDATOR_EXIT_ROLE);
  the permissionless ones (`forceRebalance`, `settleLidoFees`) only *reduce* the vault's debt to the
  protocol and are capped by `_obligationsShares` / `_settleableLidoFeesValue`.
* **Jail** — `triggerValidatorWithdrawals` rejects partial withdrawals both in jail and when
  `_obligationsShortfallValue > 0` (VaultHub.sol:886 ff., fix `13964aa`), closing the
  queue-clogging vector around forced rebalance.

## Not covered

`StakingVault.sol` internals (staged/available balance split, PDG interaction), `OperatorGrid` fee
and limit math, `RefSlotCache` overwrite edge cases beyond what `getValueForRefSlot` exercises,
and cross-vault/consolidation flows. Those remain the plausible places for a write-capable
accounting bug, but nothing in this pass produced a value-impacting path.
