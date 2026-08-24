# @deepsync/source-github

Minimal unauthenticated source for public GitHub release assets. Callers provide owner, repository, tag, asset name, and mandatory SHA-256 digest. The source validates path segments, downloads without OAuth, verifies bytes before publication, and writes a private local artifact file.
