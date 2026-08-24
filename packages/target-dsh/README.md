# @deepsync/target-dsh

DeepSeek Harness 0.1.1-rc.2 adapter. It detects the exact CLI, verifies version and capabilities, validates confined bundle manifests, delegates installation to `dsh plugin` and pnpm, observes profile selection and Loader execution, and snapshots/restores the isolated profile.

Alpha.1 accepts only a newly created DeepSync-marked DSH home with the `deepsync-test` profile. It has no code path for an existing user profile or the active Web profile.
