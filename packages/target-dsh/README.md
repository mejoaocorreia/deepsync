# @deepsync/target-dsh

DeepSeek Harness 0.1.1-rc.2 adapter. It detects the exact CLI, validates version plus capability evidence, inspects immutable packed bundle bytes, delegates installation to `dsh plugin` and pnpm, observes exact artifact selection, and snapshots/restores the complete isolated profile.

The adapter accepts only a newly created `deepsync-test` profile. Its marker binds a nonce, canonical home, schema, and profile to the target instance ID; copying the marker to another home is rejected. Existing user profiles and the active Web profile have no supported mutation path.

A plan identifies the full SHA-256 of a `.tgz`. Validation re-inspects its complete archive, rejects links, traversal, malformed manifests, unsupported target bindings, missing capabilities, unpublished entrypoints or patch files, and changed bytes. During activation, `deepsync.health/v1` correlates the plugin's built identity and version with the target instance and activation attempt. Loader observation and health status produce separate evidence. Rollback verification compares both composed config and a deterministic profile-tree digest.
