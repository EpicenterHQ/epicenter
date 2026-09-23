# Capture store contract

Importing `captureDefinition` declares one entries table and opens no storage. The caller opens it with `openPersonal(captureDefinition, { account })` and owns the resulting handle. `createEntry` mints a row and integrates its initial plain-text body in one store transaction. `entryForest` reads the current rows without mutating them, resolves missing or cyclic parent links, and sorts each child list by capture time.

`moveEntry` validates source and destination against that same visible forest, rejects descendants, and materializes affected suppressed cycle edges in one transaction. `previewDeletion` lists the exact resolved subtree and body snapshots. `deleteConfirmedSubtree` checks for local changes, deletes only those IDs in one transaction, then confirms local persistence. Unreadable rows that could belong to the subtree block the preview. Concurrent unseen children can survive and return to the timeline when their parent is deleted.

The web app is the current caller. Markdown handoff and Whispering's exact-text promotion are later waves.
