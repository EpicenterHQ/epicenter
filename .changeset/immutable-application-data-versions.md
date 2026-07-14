---
'@epicenter/workspace': minor
---

Breaking (pre-1.0): derive SQLite workspace identities from an application ID and positive data version, require a committed data version lock before opening storage, and remove independently authored workspace IDs.
