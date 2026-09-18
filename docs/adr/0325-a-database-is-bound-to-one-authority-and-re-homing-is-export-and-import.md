# 0325. A database is bound to one authority, and re-homing is export and import

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amends:** [ADR-0262](0262-the-desktop-host-owns-one-active-connection-and-no-connection-registry.md) at one clause. "Selecting a different server replaces it" is withdrawn: choosing a server becomes installing a build, so `selectInstance`, `selectHosted`, the `{ kind: 'self-hosted' }` connection record, and `ACCOUNT_INSTANCE_ROUTE` go with it. Its one-connection rule, its refusal of a saved-connection registry, and its rule that an app cannot choose a server all stand.
- **Relates:** [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) (nothing is deleted as a step in a protocol), [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) (import mints a generation), [ADR-0296](0296-rich-content-is-a-declared-field-and-a-table-owns-its-file-codec.md) (codec idempotence), [ADR-0315](0315-the-folder-is-keyed-by-data-id-and-the-segment-under-it-is-the-applications.md) (the folder this reads)
- **Amended by:** [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md) at the binding and the refusal, both withdrawn: the address carries the principal again, so there is no stamp to write and nothing to compare at open. `DatabaseBinding`, the `binding` object store, `canonicalBaseURL`, `canonicalBinding`, `isSameBinding`, and `StoreError.BoundElsewhere` are deleted. Everything about re-homing stands.
- **Unbuilt:** all of the re-homing half. The fail-closed export pass, the import verb, and the desktop binding. `readArtifact` and `createGeneration` exist; nothing calls them for re-homing, and no browser deployment can export at all. The binding and the refusal were built in the browser and are deleted; see the amendment above.

## Context

[ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md)
removed the server URL and principal from the address. Those segments were doing
real work: two authorities landed at two names, so bytes born under one could
never meet the other. Something has to keep that true.

The hazard is not theoretical and it is not loud. Two authorities mint generation
numbers independently (ADR-0293: the authority assigns `n` with an account, the
device assigns it without), and generation numbers are small integers, so `7`
usually exists on both. Yjs merges rather than erroring. The failure mode is
silent interleaving of two unrelated histories, not a crash.

An earlier draft of this record made rebinding *destructive*: gate the change,
wipe every account-bound database, order the writes so the new binding lands
last. That is machinery to build, test, and get right, and it deletes data as a
step in a protocol, which ADR-0281 refuses.

## Decision

**A database that has bound to an authority stays bound to it. There is no
in-place transition to another.**

**The binding is stamped inside the database, in the transaction that creates
it, and never rewritten.** The stamp is the canonical base URL and the verified
principal. No code path updates a stamp on an existing database, which makes a
rebound database unrepresentable rather than detected. On desktop it is written
inside the transaction that creates the file's schema; in a browser, in the same
transaction that applies the bootstrap state.

**One refusal at open, and the person owns the deletion.** A database whose stamp
does not match the current authority is refused, with a message that offers one
person-invoked erase. Nothing is deleted as a step (ADR-0281); a person deletes,
and the refusal is where they are told they can.

**Re-homing is export, then import.** Both verbs already exist and neither is new
machinery:

```txt
  authority A                                     authority B
       │                                               ▲
       │ renderArtifact                                │ readArtifact
       ▼                                               │
   <table>/<rowId>.md  +  kv.json  ── a folder ────────┘
                                        createGeneration mints n at B
```

The mirror leaf folder **is** an import folder. `layout.ts` holds one inverse
pair and `frontmatter.ts` the other, and `readArtifact` ignores anything that is
not `kv.json` or a two-segment `.md` path, so `tables.sqlite`, `.DS_Store`, and a
README pass through harmlessly.

**The re-home export is a fresh, fail-closed pass, and not the standing mirror.**
`renderArtifact` deliberately does not fail closed, because a mirror that stops
on one bad row leaves a folder that lies about the rest; import deliberately does,
because a file it silently skipped is data deleted everywhere. Both are
correct. The consequence is that a standing mirror may hold one row's stale body
with no signal, so zipping `~/Epicenter` and importing it is a silent per-row
rollback. A re-home export collects `renderArtifact`'s results and refuses on any
`Err`.

**What travels is the final state, not the history.** Import builds one fresh Yjs
document and the new authority mints a new number. Prior generations, undo
metadata, and restore points stay behind. A blob reference travels; the blob
bytes do not.

## Consequences

- The destructive-rebind machinery is never built: no wipe, no write-ordering
  discipline, no crash-between-wipe-and-restamp analysis, no transition UI.
- `POST` and `DELETE /_epicenter/account/instance` are deleted, along with
  `selectInstance`, `selectHosted`, `normalizeInstanceUrl`, and the
  `{ kind: 'self-hosted' }` deployment record in
  `apps/epicenter/src/desktop-auth-authority.ts`. **This is the urgent half.**
  Those routes are in-place rebinding at host altitude; they were safe only
  because the address then carried the server URL. **ADR-0324 has landed in the
  browser**, so the binding written by `BrowserBacking.create` is what makes
  them safe now: an in-place rebind reaches a record whose binding no longer
  matches, and the open is refused rather than merged. They are still deleted.
- The stamp is one comparison at one moment. It is the floor, not an oversight:
  a principal is asserted by a remote party at first sign-in, after local data can
  already exist, so no address can know it in time. Everything a deployment
  decides can be structural; what a person decides must be checked.
- Two things have to be built before re-homing is a supported act: a fail-closed
  export wrapper, and an import verb (a folder or zip reader). Today
  `createGeneration`'s only shipping caller is empty-first-run.
- Browser deployments cannot export at all, because `renderArtifact` needs a
  host. ADR-0271 refused browser export as "refused, not deferred," on the premise
  that ADR-0227 had refused hosted web; ADR-0310 has since amended ADR-0227 and a
  browser build is a target again, so that refusal now rests on a retired premise.
  That refusal has to be re-made or replaced on current premises; this record
  does not settle which.
- On desktop, `apps/<app-id>/` holds the bundle and the data, so the erase and the
  uninstall are the same `rm -rf` at two depths. Re-homing needs no verb the
  install plane does not already need.

## Considered alternatives

- **Make rebinding destructive rather than refusing it.** Rejected. It is
  machinery to keep a promise nobody currently uses: Honeycrisp has no sign-out
  button, and the flows that do exist (first bind, reauth of the same principal)
  are untouched by a refusal. It also deletes data as a protocol step, which
  ADR-0281 refuses.
- **Keep the server URL and principal in the address.** Rejected by ADR-0324, and
  see its alternatives. The trade is honest and worth naming: the address enforced
  isolation structurally with no check to forget, and this record trades that for
  one recorded binding plus one refusal.
- **Merge on first bind.** Rejected. Honeycrisp's account destination "never
  silently shows device data," and merging two histories produces a third, which
  under ADR-0293 would make adopting an authority a second way a generation comes
  into being. Under ADR-0324 the two notebooks are two data ids, so there is
  nothing to merge.
- **Erase local data at sign-out, so a fresh sign-in always meets an empty
  store.** Rejected: ADR-0262 preserves local data across sign-out because that is
  the product. Data that dies with a session is a cache.
