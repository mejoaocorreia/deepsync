# @deepsync/doctor

Deterministic environment and plugin checks run before any optional future AI analysis. Every check returns timestamped pass, fail, warning, or skipped evidence; thrown checks become contained failures without preventing independent checks.

`validatePluginInput(path)` validates a DSH plugin source directory or complete `.tgz` and returns `PluginValidationReport`. Invalid reports contain stable issue codes, JSON Pointer paths, messages, and remediation.
