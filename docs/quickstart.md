# Quickstart

The public alpha requires Node.js 22.19 or 24+, pnpm 11.7, and a DeepSeek Harness 0.1.1-rc.2 source checkout. It creates one new `deepsync-test` profile in a dedicated home. The home must not contain an existing profile; the CLI rejects an absent, obsolete, copied, or mismatched isolation marker after creation.

```powershell
pnpm install --frozen-lockfile
pnpm run build

$DshRoot = 'C:\path\to\deepseek-harness'
$RunRoot = Join-Path $env:TEMP ('deepsync-quickstart-' + [guid]::NewGuid())
$Home = Join-Path $RunRoot 'dsh-home'
$Plan = Join-Path $RunRoot 'plan.json'
$State = Join-Path $RunRoot 'state.json'

node apps/cli/dist/bin.mjs plan add fixtures/dsh-lifecycle-probe `
  --dsh-root $DshRoot --home $Home --mode healthy --out $Plan --state $State
node apps/cli/dist/bin.mjs apply $Plan --state $State
if ($LASTEXITCODE -ne 0) { throw "DeepSync apply failed with exit $LASTEXITCODE" }
node apps/cli/dist/bin.mjs doctor --dsh-root $DshRoot --home $Home --state $State
node apps/cli/dist/bin.mjs status --state $State
```

`plan add` runs `pnpm pack`, validates the packed manifest, writes a full-digest `.tgz` to `.deepsync/artifacts`, and records that immutable path. Apply automatically recovers uncertain transactions in the same state file before attempting the requested mutation. Use one state file for one isolated target.

## Forced failure and recovery

The lifecycle probe has deterministic failure modes for release verification. Use a fresh isolated home and state for this rollback example:

```powershell
$FailureRoot = Join-Path $env:TEMP ('deepsync-failure-' + [guid]::NewGuid())
$FailureHome = Join-Path $FailureRoot 'dsh-home'
$FailurePlan = Join-Path $FailureRoot 'plan.json'
$FailureState = Join-Path $FailureRoot 'state.json'

node apps/cli/dist/bin.mjs plan add fixtures/dsh-lifecycle-probe `
  --dsh-root $DshRoot --home $FailureHome --mode health-failure `
  --out $FailurePlan --state $FailureState
node apps/cli/dist/bin.mjs apply $FailurePlan --state $FailureState
if ($LASTEXITCODE -ne 21) { throw "Expected quarantined exit 21, received $LASTEXITCODE" }
node apps/cli/dist/bin.mjs status --state $FailureState
node apps/cli/dist/bin.mjs recover --dsh-root $DshRoot --home $FailureHome --state $FailureState
```

A quarantined result includes `restored: true` only after profile-tree and composed-config verification. Status reports the full artifact digest under `quarantined`. `recover` is idempotent and returns any nonterminal transactions it completed.

An explicit rollback is allowed only for the current committed target head:

```powershell
node apps/cli/dist/bin.mjs rollback <request-id> `
  --dsh-root $DshRoot --home $Home --state $State
```

Every command accepts `--json`. Stable nonzero exits are 2 for usage, 10 for an unhealthy Doctor report, 20 for a pre-mutation rejection, 21 for a quarantined apply, and 22 for an unverified explicit rollback. The GitHub source package supports bounded streaming of unauthenticated public release assets with a mandatory SHA-256 and an offline verified cache; CLI integration remains feature-gated while the lifecycle path uses local packed artifacts.
