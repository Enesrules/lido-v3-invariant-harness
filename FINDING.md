# Lido V3 PredepositGuarantee — hunt #1 decision

Repo: `~/.hermes/cache/scratch/lido/repo` @ `2bd5322` (2026-10-13).
Artifacts: `compile.js` (real repo sources, solc 0.8.25, viaIR, repo optimizer settings),
`run.js` (in-process EVM, real `PredepositGuarantee` behind a 20-line test-only proxy),
`TinyProxy.sol` (scaffolding only), `artifacts.json`.

## DECISION: NO_FINDING

No submittable Immunefi finding for the four named invariant classes. Each is enforced by a
specific line; the executable harness (16/16 checks) exercises the ledger half of each.

| # | Invariant | Enforced by | Harness evidence |
|---|---|---|---|
| 1 | Valid beacon deposit cannot be slashed unfairly: only a *mismatching* on-CL WC can seize the 1 ETH guarantee, and it must equal the WC actually committed in the validator record | `proveInvalidValidatorWC` reverts `WithdrawalCredentialsMatch()` when the proven WC equals the vault's WC (PDG:580-582); the WC is bound to the pubkey by the leaf `sha256Pair(pubkeyRoot, wc)` at `CLProofVerifier.sol:160` | ledger side: `NotEnoughUnlocked` blocks seizure when no balance exists; locked withdrawal blocked |
| 2 | Invalid (frontrun) deposit cannot dodge slashing: compensation is unconditional on the invalid path, no stage shortcut skips it | `validate → stage!=PREDEPOSITED revert` (PDG:573-575) then `balance.total -= 1e18; balance.locked -= 1e18` (PDG:592-593) in the same tx as `stage = COMPENSATED` (PDG:586). No other function writes `COMPENSATED`, and `proveWCActivateAndTopUpValidators` rejects it explicitly (PDG:670) | `ValidatorNotNew` + stage assertion on the double-predeposit path |
| 3 | Same deposit cannot be proven twice: `_proveWC` (unlock 1 ETH) is only reachable from `PREDEPOSITED` and each caller moves the stage out of it in the same tx | `proveWCAndActivate` stage guard PDG:466-468; `proveWCActivateAndTopUpValidators` PDG:661 rejects `NONE`/`COMPENSATED` and only calls `_proveWC` under `stage == PREDEPOSITED` (PDG:684-686), then forces `ACTIVATED` (PDG:689-690). `_proveWC` has no own guard (PDG:716) — safe only because both call sites are gated | 2nd predeposit of same pubkey reverts `ValidatorNotNew`, `pendingActivations` unchanged |
| 4 | `pendingActivations` cannot desync from `stagedBalance` while connected | Only PDG mutates both: `predeposit` does `+= len` (PDG:426) and `stage(31e18*len)` (PDG:453) in one tx; `_activateAndTopUpValidator` does `-= 1` (PDG:739) and `depositFromStaged` → `unstage(31e18)` (StakingVault:339); `proveInvalidValidatorWC` does `-= 1` (PDG:594) and `unstage(31e18)` (PDG:598). While connected `depositor == PDG` (VaultHub:380) and owner is VaultHub, so no third party can touch `stage/unstage` | `staged == pendingActivations * 31e18` and `locked == pendingActivations * 1e18` hold after every state change; `VaultHub.sol:382` equality is the invariant's own assertion |

Also checked and clean:
- `SSZ.verifyProof` enforces exact path length (`BranchHasExtraItem` / `BranchHasMissingItem`) and `_verifySlot` binds `slot`/`proposerIndex` as `proof[len-2]`, so a short/long proof cannot walk to a chosen root.
- `GIndex.shr` is neighbour arithmetic (`i + n`, bounds-checked), not a path rewrite — `_getValidatorGI` cannot be steered to another validator's subtree.
- Guarantee ledger: `withdrawNodeOperatorBalance` / `setNodeOperatorGuarantor` both refuse while `locked != 0`; `locked` is only released by `_proveWC` (proof-backed) or compensation.

Non-finding worth noting (NOT submittable — no attacker gain, owner-self-inflicted):
`VaultHub.connectVault` (line 382) asserts `stagedBalance == pendingActivations*31`. After
`disconnectVault`, the vault owner regains ownership and can `setDepositor(self)` (StakingVault:483,
`onlyOwner`) and then call `unstage()` directly (StakingVault:320) on the 31 ETH reserved for a
still-pending validator. `pendingActivations` stays > 0, staged drops to 0, and every future
`connectVault` reverts `InsufficientStagedBalance` — a self-brick of that vault's staged ether, not
a theft or third-party grief. Not reported.

## Reproduce
```
cd ~/.hermes/cache/scratch/lido-hunt1 && node compile.js && node run.js
```
No network, no mainnet interaction. `@ethereumjs/vm` has no EIP-2537 precompiles, so 0x0b–0x11 are
stubbed (pairing returns true) purely to pass `BLS.verifyDepositMessage`; the contract under test is
the unmodified repo bytecode.