# 0001 — Independent target-neutral foundation

## Decision

DeepSync is a separate monorepo. Core is headless, target-neutral, empty by default, and independent of DSH and Cortex. Target adapters implement explicit public interfaces. The DSH adapter delegates package and runtime work to pnpm, DSH profiles, and Cordis.

## Consequences

The initial package count is accepted to make dependency direction mechanically enforceable. Small lifecycle concepts begin as isolated modules inside Core with public indexes and package-level tests. No existing Legacy or Cortex identity is renamed or migrated.
