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

Every target mutation follows `ChangeRequest -> ChangePlan -> Validate -> Snapshot -> Apply -> Observe -> Health -> Commit`. A failure after mutation follows `Rollback -> Verify rollback -> Failed`, and the rejected artifact digest is quarantined. A committed snapshot becomes last-known-good.

Manifest declarations are claims. Verifier evidence establishes compatibility and health. The DeepSync lock fixes source identity, artifact digest, resolved plugin version, target instance, and verifier evidence. Target-native package-manager locks remain authoritative for their dependency graphs.

## Ownership

DeepSync owns lifecycle intent, target discovery, compatibility policy, evidence, transaction records, quarantine, and last-known-good references. Target adapters delegate package installation, composition, runtime lifecycle, settings, persistence, and RPC to target-native mechanisms.

Compatibility, health, installation state, desired activation state, observed activation state, trust, and update state are independent values. Required and optional capabilities remain distinct; each capability is portable or target-specific.

## Reliability scope

Alpha.1 applies only to isolated, disposable, or explicitly stopped target instances. It never mutates or restarts an active DSH Web profile. Advanced signing, containers, certification, telemetry, AI Doctor, Hub, accounts, ratings, payments, Creator, Worms, and targets other than DSH are outside Alpha.1.
