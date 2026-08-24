# DeepSync architecture

DeepSync is a target-neutral extension lifecycle platform. It is not an agent harness and never executes managed extensions. A target runtime executes an extension when that target supports activation.

## Dependency direction

```text
contracts <- core <- doctor
                 <- target adapters <- optional target-side bridges
contracts <- sources
plugins consume contracts and sit above targets
```

`@deepsync/core` has no dependency on DeepSeek Harness, Cordis, Cortex, MCP, React, GitHub sources, network access, or a plugin runtime. It starts with no adapters and uses in-memory state unless a caller supplies persistence.

## Lifecycle

Every target mutation follows `ChangeRequest -> ChangePlan -> Validate -> Snapshot -> Apply -> Observe -> Health -> Commit`. A failure after mutation follows `Rollback -> Verify rollback -> Quarantine`. The terminal transaction, quarantine or LKG index, and per-target transaction head are published in one state revision.

The request fingerprint binds target instance and canonical intent. A supplied plan must bind the exact request, target, adapter, artifact digest, and recomputed plan digest. Quarantine keys combine the target instance with the complete artifact digest. Only the current committed target head can be rolled back, so an older transaction cannot overwrite newer state.

A pre-change snapshot is reserved for rollback. A second snapshot taken after successful health becomes the committed LKG. Recovery inspects durable phases, verifies an already attempted rollback before repeating it, repairs missing terminal indexes, and blocks a new mutation while the same target has an uncertain transaction. File-backed state uses compare-and-swap revisions, atomic replacement, durable file flushes, and a cross-process run lock.

## Artifact plane

A local DSH source is packed with pnpm before planning. The immutable `.tgz` cache name contains its complete SHA-256. Validation re-inspects all archive bytes, rejects archive links and traversal, validates package, DeepSync, DSH target, capability, patch, and health declarations, and checks the digest again immediately before staging inside the snapshotted profile. Target-native package-manager locks remain authoritative for dependency graphs.

Manifest declarations are claims. Verifier evidence establishes compatibility and health. The DeepSync lock fixes source identity, artifact digest, resolved plugin version, target instance, and verifier evidence.

## Ownership

DeepSync owns lifecycle intent, target discovery, compatibility policy, evidence, transaction records, quarantine, and last-known-good references. Target adapters delegate package installation, composition, runtime lifecycle, settings, persistence, and RPC to target-native mechanisms.

Compatibility, health, installation state, desired activation state, observed activation state, trust, and update state are independent values. Required and optional capabilities remain distinct; each capability is portable or target-specific.

## Reliability scope

This alpha applies only to a newly created, dedicated target instance. It never mutates or restarts an active DSH Web profile. Advanced signing, containers, certification, telemetry, AI Doctor, Hub, accounts, ratings, payments, Creator, Worms, and targets other than DSH are out of scope.
