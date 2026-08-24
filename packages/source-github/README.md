# @deepsync/source-github

Unauthenticated source for exact public GitHub Release assets. Callers provide owner, repository, immutable tag, exact asset name, and mandatory SHA-256 digest through `GitHubReleaseSourceReferenceV1`. The source rejects mutable tag aliases, validates path segments, reports not-found and rate-limit outcomes, streams with a size bound, verifies complete bytes before atomic cache publication, and reuses only digest-verified offline cache entries.
