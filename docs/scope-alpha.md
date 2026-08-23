# Alpha.1 scope

DeepSync 0.1.0-alpha.1 supports deterministic status and doctor reports, change planning, transactional apply and rollback, quarantine, last-known-good recovery, a local artifact source, a minimal public GitHub release-asset source, and DeepSeek Harness 0.1.1-rc.2 as its first target.

The DSH adapter works only with isolated/disposable profiles or profiles whose owner explicitly declares them stopped. It delegates dependency operations to pnpm and uses DSH profile and Cordis lifecycle primitives. Live Web profile mutation is rejected.

The release proves one healthy fixture and deliberate activation and health failures. It does not migrate existing plugins or replace DeepSync Legacy.
