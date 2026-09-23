# Capture store contract

Importing `captureDefinition` declares one entries table and opens no storage. The caller opens it with `openPersonal(captureDefinition, { account })` and owns the resulting handle. `createEntry` mints a row and integrates its initial plain-text body in one store transaction. `entryForest` reads the current rows without mutating them, resolves missing or cyclic parent links, and sorts each child list by capture time.

The web app is the current caller. Whispering's exact-text promotion is a later wave. The first slice does not move or delete entries.
