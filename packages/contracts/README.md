# @deepsync/contracts

Public, versioned DeepSync types and runtime JSON validation for plugin manifests, target bindings, DSH health results, artifact sources, lifecycle plans, evidence, adapters, and lockfiles.

Use only the package root and the explicit schema exports:

- `@deepsync/contracts`
- `@deepsync/contracts/schemas/plugin-manifest-v1.json`
- `@deepsync/contracts/schemas/dsh-target-binding-v1.json`
- `@deepsync/contracts/schemas/dsh-health-result-v1.json`

`validatePluginManifestDocument`, `validateDshTargetBindingDocument`, and `validateDshHealthResultDocument` return stable issue codes, JSON Pointer paths, and remediation without throwing. The corresponding `assert*` functions throw `ContractValidationError`.
