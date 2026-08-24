# DeepSync 0.1.0-alpha.2

Alpha.2 hardens the Foundation vertical slice for reproducible public evaluation. It does not add new targets or product surfaces.

## Included

- Target-neutral Core transactions bind canonical request intent, target instance, adapter, plan digest, and complete artifact digest.
- Terminal transaction records publish atomically with quarantine, LKG, and per-target head indexes.
- Pre-change rollback snapshots are separate from post-health committed LKG snapshots.
- Recovery is phase-aware, blocks uncertain same-target mutations, verifies attempted rollback before retry, and uses a cross-process file lock for durable CLI state.
- The DSH adapter accepts complete packed `.tgz` bytes, rejects unsafe archives and malformed or unsupported declarations, binds the canonical isolated home plus nonce, and verifies both composed config and profile-tree content after rollback.
- CLI apply performs automatic recovery and returns stable usage, Doctor, rejection, quarantine, and rollback exit codes.
- Doctor enforces Node.js `^22.19.0 || >=24.0.0` and the exact DSH `0.1.1-rc.2` evidence baseline.
- Public GitHub release downloads are streamed with a size bound, complete digest verification, atomic full-digest caching, and offline cache reuse.
- Release gates verify all package exports and the CLI executable from local tarballs in offline consumer mode.

## Compatibility evidence

DSH compatibility is limited to version `0.1.1-rc.2` at public source commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. CI checks the packed healthy path, deterministic activation and health failures, verified rollback, quarantine, and prior committed LKG restoration against that exact commit.

## Safety limits

Only a newly created `deepsync-test` profile in a dedicated nonce-bound home is supported. Existing profiles, copied markers, the active Web profile, migration, other targets, Hub/UI, telemetry, signing, Creator, Worms, and AI Doctor remain out of scope.

All npm package manifests remain private. This release can publish GitHub source and artifacts after gates pass, but npm publication requires verified namespace ownership and is not part of this checkpoint.
