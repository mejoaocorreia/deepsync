# Public alpha scope

DeepSync vNext supports deterministic status and Doctor reports, immutable local artifact packing, change planning, transactional apply and rollback, quarantine, last-known-good recovery, a bounded public GitHub release-asset source, and DeepSeek Harness 0.1.1-rc.2 as its first target.

The DSH adapter accepts only a newly created `deepsync-test` profile in a dedicated home. Its marker binds the canonical home and a random nonce to the target instance. There is no supported path for an existing profile, a copied marker, or the active Web profile. Dependency and profile operations are delegated to DSH and pnpm.

The release proves a packed healthy fixture, deliberate activation and health failures, rollback content equality, artifact quarantine, committed-state LKG restoration, durable crash recovery, and request replay. It does not migrate existing plugins or replace DeepSync Legacy.

Advanced signing, containers, certification, telemetry, AI Doctor, Hub, accounts, ratings, payments, Creator, Worms, and targets other than DSH are outside this alpha.
