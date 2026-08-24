# Compatibility baseline

DeepSync 0.1.0-alpha.3 is developed and verified against DeepSeek Harness `0.1.1-rc.2`, upstream tag `dsh-v0.1.1-rc.2` at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

The adapter must also prove required capabilities: readable profile manifests, `dsh.profile.bundles`, `dsh.bundle.patch`, a working `dsh --profile <name> --dump-config`, pnpm availability, and target-side activation evidence. Version matching alone never establishes compatibility.

Preserved external identities:

- package, plugin, and settings identity `deepsync-legacy`;
- package and plugin identity `cortex-core`;
- existing Cortex gateway store format and MCP entrypoints;
- the active DSH Web profile bundle order and user patches.

The new repository contains no imports from or copies of private Cortex code. Preservation is verified before and after target integration tests.
