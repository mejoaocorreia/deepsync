# Quickstart

Alpha.1 requires Node.js 22.19 or 24+, pnpm 11.7, and a DeepSeek Harness 0.1.1-rc.2 checkout. It creates a new isolated `deepsync-test` profile and refuses an unmarked DSH home. It never opens or modifies the user's existing DSH home.

```powershell
pnpm install
pnpm run build

$DshRoot = 'C:\path\to\deepseek-harness'
$RunRoot = Join-Path $env:TEMP 'deepsync-quickstart'
$Home = Join-Path $RunRoot 'dsh-home'
$Plan = Join-Path $RunRoot 'plan.json'
$State = Join-Path $RunRoot 'state.json'

node apps/cli/dist/bin.mjs plan add fixtures/dsh-lifecycle-probe `
  --dsh-root $DshRoot --home $Home --mode healthy --out $Plan --state $State
node apps/cli/dist/bin.mjs apply $Plan --state $State
node apps/cli/dist/bin.mjs doctor --dsh-root $DshRoot --home $Home --state $State
node apps/cli/dist/bin.mjs status --state $State
```

To prove rollback and quarantine, create a new isolated home and plan with `--mode health-failure`, then apply it. The result is `quarantined` with `restored: true`; status reports the artifact digest under `quarantined`.

An explicit rollback of a committed transaction uses its request ID:

```powershell
node apps/cli/dist/bin.mjs rollback <request-id> `
  --dsh-root $DshRoot --home $Home --state $State
```

Every command accepts `--json`. The GitHub source package supports unauthenticated public release assets with a mandatory SHA-256 digest; CLI integration remains feature-gated in Alpha.1, while the lifecycle path uses a local package source.
