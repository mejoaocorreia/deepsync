# deepsync CLI

Commands: `status`, `doctor`, `doctor plugin`, `plugin validate`, `plan add`, `apply`, `rollback`, and `recover`. `plan add` accepts a local package or an exact digest-bound public GitHub Release asset. Every command supports structured JSON output. Apply performs recovery before mutation, and terminal failure outcomes use stable nonzero exit codes. See the repository plugin-authoring guide and quickstart for the supported isolated DSH workflow.
