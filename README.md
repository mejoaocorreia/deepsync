# DeepSync

DeepSync is a target-neutral lifecycle platform for extensions of AI harnesses and agent runtimes. It manages public plugin contracts, deterministic artifact resolution, compatibility evidence, immutable planning, staging, activation observation, generic health, rollback, quarantine, and last-known-good state. It is not a harness and does not execute extensions.

DeepSeek Harness 0.1.1-rc.2 is the first and only supported target baseline. The public alpha creates a new nonce-bound isolated DSH home; it has no supported mutation path for an existing profile or the active Web profile.

## Install from source

DeepSync 0.1.0-alpha.3 is prepared as GitHub source and release tarballs. npm installation remains unavailable until the existing `@deepsync` scope grants access to the maintainer account.

```sh
git clone https://github.com/mejoaocorreia/deepsync.git
cd deepsync
git checkout main
pnpm install --frozen-lockfile
pnpm run build
node apps/cli/dist/bin.mjs --version
```

Authors can start with the [plugin author workflow](docs/plugin-authoring.md) and the valid [DSH plugin template](docs/templates/dsh-plugin). The CLI validates source directories and packed artifacts before they enter the lifecycle:

```sh
node apps/cli/dist/bin.mjs plugin validate docs/templates/dsh-plugin --json
```

See the [working quickstart](docs/quickstart.md), [architecture](docs/architecture.md), [alpha scope](docs/scope-alpha.md), [compatibility matrix](docs/compatibility-matrix.md), and [changelog](CHANGELOG.md).

> All DeepSync package manifests remain private. Release preparation and the documented workflow do not publish npm packages.
