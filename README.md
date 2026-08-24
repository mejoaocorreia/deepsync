# DeepSync

DeepSync is a target-neutral lifecycle platform for extensions of AI harnesses and agent runtimes. It manages discovery, compatibility evidence, immutable artifact planning, staging, activation observation, health, rollback, quarantine, and lock state. It is not a harness and does not execute extensions.

DeepSeek Harness 0.1.1-rc.2 is the first and only supported target baseline. The public alpha creates a new nonce-bound isolated DSH home; it has no supported mutation path for an existing profile or the active Web profile.

## Install from source

DeepSync 0.1.0-alpha.2 is distributed as GitHub source and release tarballs. npm installation is not supported until ownership of `deepsync` and `@deepsync` is verified.

```sh
git clone https://github.com/mejoaocorreia/deepsync.git
cd deepsync
git checkout v0.1.0-alpha.2
pnpm install --frozen-lockfile
pnpm run build
node apps/cli/dist/bin.mjs --version
```

Start with the [working quickstart](docs/quickstart.md). See [architecture](docs/architecture.md), [alpha scope](docs/scope-alpha.md), the [compatibility matrix](docs/compatibility-matrix.md), [changelog](CHANGELOG.md), and [Alpha.2 release notes](docs/release-notes-0.1.0-alpha.2.md).

> All package manifests remain private. Release preparation and the documented workflow do not publish npm packages.
