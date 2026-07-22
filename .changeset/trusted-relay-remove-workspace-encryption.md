---
'@epicenter/identity': minor
---

Remove the workspace keyring from the identity contract now that the sync relay is trusted.

`AuthState` drops the `keyring` field from its `signed-in` and `reauth-required` variants. `ownerId` still identifies the local storage partition.
