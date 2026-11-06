# Arc notes (Agent B)

Resolves INTEGRATION U4/U5. Verified Fri 6 Nov 2026.

## Network (U4)

| Item | Value | How confirmed |
|---|---|---|
| Network | Arc Testnet | Arc Studio chain registry |
| Chain id | 5042002 | `eth_chainId` on the RPC (write-deployment.mjs) |
| RPC | https://rpc.testnet.arc.io | used for every deploy/grant/fund tx |
| Explorer | https://explorer.testnet.arc.io | tx links resolve |
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000` | Studio chain registry; `decimals()` returns **6** |
| Gas token | USDC (native, 18 decimals) - same balance as the ERC-20 view | wallet showed equal native/ERC-20 balances |
| Faucet | Studio "Get test USDC" / faucet.circle.com (Arc Testnet) | 20 USDC grant |

MockUSDC was **not** needed.

## Compiler and imports (U5)

- Studio compiles with Foundry, solc 0.8.26, optimizer 200 runs.
- No OpenZeppelin dependency: `contracts/src/lib/` vendors minimal AccessControl, ReentrancyGuard and SafeERC20.
- Studio's chat input truncates long pastes; use the file editor and paste one flattened file (`forge flatten`), here `contracts/Proofwork.sol` in the Studio project.

## Deployments

| | Address | Admin | Notes |
|---|---|---|---|
| AttestationRegistry | `0x9ab5E0cc44b7336DE8306c9f2F91d7cC832d5112` | `0xaa08…b6a2` (B) | **live** - in deployments/arc.json |
| BonusVault | `0x3FE940C4F1464d769795d24157037BEf7C3ec97F` | `0xaa08…b6a2` (B) | **live**; asset = USDC above |
| AttestationRegistry (Studio) | `0xe7b555dbb43283fda93ac1c2c0373e88eb4365d7` | Studio platform deployer | first deploy from Studio; unusable (cannot grant roles) |
| BonusVault (Studio) | `0x3059a94b0e55a93965711748b8472f3024c6a0fc` | Studio platform deployer | same |

Studio's built-in deploy signs with a shared platform account, which then holds `DEFAULT_ADMIN_ROLE`; its "self-deploy" uses a Circle developer-controlled wallet. Neither gives a key our scripts can use, so the live pair was deployed with `forge create` from B's own testnet wallet, same source and compiler settings as Studio.

Roles: registry ANCHOR + ATTESTER -> A's anchor key `0x93a7…2A58`; vault PLANNER + PAYOUT + DISPUTER + RESOLVER -> A's payout key `0x0351…EF54` (`contracts/scripts/grant-roles.mjs`).

## Funding (CR-003)

- Vault funded with 5 USDC per cycle (1 and 2); A's keys got 2 USDC gas each (`contracts/scripts/fund.mjs`).
- Demo targets are 5,000 USDC, so A runs the vault at 1/`CHAIN_AMOUNT_DIVISOR` = 1/10,000 of API amounts. The web shows "On-chain amounts scaled 1:10,000" in live mode (`ChainScaleNote`).
- One full `e2e:chain --full` run costs about 0.45 USDC of cycle 1.

## Scripts

```
node contracts/scripts/write-deployment.mjs --registry 0x... --vault 0x...   # read-only checks, writes deployments/arc.json
node contracts/scripts/grant-roles.mjs [--dry-run]
node contracts/scripts/fund.mjs --amount <usdc per cycle> [--gas-each <usdc>] [--dry-run]
```
Deployer key: `contracts/.env` (`DEPLOYER_PRIVATE_KEY`, gitignored).
