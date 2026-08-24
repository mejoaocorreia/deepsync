# Quickstart

DeepSync 0.1.0-alpha.3 requires Node.js 22.19 or 24+, pnpm 11.7, and a DeepSeek Harness 0.1.1-rc.2 source checkout. It creates one new `deepsync-test` profile in a dedicated home. The home must not contain an existing profile; the CLI rejects an absent, obsolete, copied, or mismatched isolation marker after creation.

```powershell
pnpm install --frozen-lockfile
pnpm run build

$DshRoot = 'C:\path\to\deepseek-harness'
$RunRoot = Join-Path $env:TEMP ('deepsync-quickstart-' + [guid]::NewGuid())
$Home = Join-Path $RunRoot 'dsh-home'
$Plan = Join-Path $RunRoot 'plan.json'
$State = Join-Path $RunRoot 'state.json'

node apps/cli/dist/bin.mjs plugin validate docs/templates/dsh-plugin --json
node apps/cli/dist/bin.mjs plan add docs/templates/dsh-plugin `
  --dsh-root $DshRoot --home $Home --out $Plan --state $State --json
node apps/cli/dist/bin.mjs apply $Plan --state $State --json
if ($LASTEXITCODE -ne 0) { throw "DeepSync apply failed with exit $LASTEXITCODE" }
node apps/cli/dist/bin.mjs doctor --dsh-root $DshRoot --home $Home --state $State --json
node apps/cli/dist/bin.mjs status --state $State --json
```

`plan add` runs `pnpm pack`, validates the complete archive, writes a full-digest `.tgz` to `.deepsync/artifacts`, and records that immutable path. Apply automatically recovers uncertain transactions in the same state file before attempting the requested mutation. Use one state file for one isolated target.

## Forced health failure and recovery

Use a copy of the public template in a fresh home. Change its health result from `"healthy"` to `"unhealthy"`, validate it, and apply it with the same commands. A valid unhealthy result returns exit 21 with `status: "quarantined"` and `restored: true`. Malformed or mismatched results have the same safe lifecycle outcome.

A quarantined result includes `restored: true` only after profile-tree and composed-config verification. Status reports the full artifact digest under `quarantined`. `recover` is idempotent and returns nonterminal transactions it completed:

```powershell
node apps/cli/dist/bin.mjs recover --dsh-root $DshRoot --home $Home --state $State --json
```

An explicit rollback is allowed only for the current committed target head:

```powershell
node apps/cli/dist/bin.mjs rollback <request-id> `
  --dsh-root $DshRoot --home $Home --state $State --json
```

Every command accepts `--json`. Stable nonzero exits are 2 for usage, 10 for an unhealthy Doctor report, 12 for invalid plugin validation, 20 for a pre-mutation rejection, 21 for a quarantined apply, and 22 for an unverified explicit rollback. See the [plugin author workflow](plugin-authoring.md) for manifests, generic health, packaging, and immutable GitHub Release sources.
