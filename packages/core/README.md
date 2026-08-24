# @deepsync/core

Headless target-neutral lifecycle engine. It starts empty, accepts explicit target adapters, journals every transition, persists the uncertainty marker before apply, verifies rollback, quarantines failed plan digests, and keeps last-known-good snapshots. It imports no target runtime, Cortex, UI, network source, or extension execution mechanism.
