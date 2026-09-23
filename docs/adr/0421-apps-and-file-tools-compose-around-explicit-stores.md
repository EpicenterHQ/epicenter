# 0421. Apps and file tools compose around explicit stores

- **Status:** Proposed
- **Date:** 2026-09-21
- **Unbuilt:** Product composition of independent capabilities, owner-routed working copies, executable config validation, checkout-aware Matter integration, and headless project provisioning. Host admission, initial record creation, and complete attachment transfer remain unresolved.

## Context

Whispering gives recordings a specialized interface. Matter gives typed Markdown
folders a generic table interface. A person should be able to work with the same
supported data through an app, Matter, an editor, or a script without each tool
inventing its own storage and schema interpretation.

`openLocal` and `openPersonal` already own separate lifetimes.
`@epicenter/app/open` exports the explicit store openers from
`packages/app/src/open-store.ts`. Independent capability constructors and
store-owned blobs are implemented. `defineStore` declares their data schema.
Matter's `createVault` discovers table folders through `matter.json` and follows
file changes. These provide parts of the target, but do not yet implement a
shared app-to-working-copy workflow. A definition also does not transport
the originating app's behavior.

## Decision

**Apps and file tools compose around explicit stores and ordinary working files.**

A definition declares a store's stable ID, tables, and KV. A host is the process
or browser context that runs its local replica and owns persistence. An app
composes store handles and product behavior. Matter currently interprets its own
table-folder contracts. The CLI validates through an authored TypeScript config
and routes Pull/Push to the identified host.

```text
Developer's definition
         |
  Store run by a host <----> Specialized app
         |
     Pull / Push
         |
  Portable working folder
         |
    Matter / editor / scripts
```

The composition has the following boundaries:

| Component | Responsibility |
| --- | --- |
| Definition | Declared data contract; it grants no access by itself |
| Store host | Local persistence ownership, store operations, and synchronization when configured |
| Specialized app | Product behavior and explicit choice of store handles |
| Matter | File interpretation, generic field editing, and display |
| CLI | Explicit config execution for validation; owner-routed Pull/Push |
| SQL projection | Derived reads with a stated source and freshness |

[ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md)
describes independent stores for explicit local, personal, and shared owners.
An app opens only the stores it needs. A definition can be reused across owners
without making those stores the same data. No mandatory runtime aggregate is
needed merely to collect their handles. Each opened store owns its blob namespace.
Products separately choose SQL, secret, recording, and inference resources under
[ADR-0423](0423-app-resources-open-as-independent-handles.md). Importing a schema
opens nothing. Store-owned blobs do not make rows own byte retention or transfer.

[ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) describes
Push as permitted field differences against a durable checkout baseline.
Apps edit their live stores. People and agents edit working files and submit
through Push. Scripts that edit files do not acquire a second persistence owner.
Baseline and recovery state are not disposable query caches.

[ADR-0420](0420-epicenter-working-copies-use-the-matter-file-contract.md) describes
the shared parser and root `epicenter.config.ts` read lens. Standalone Matter
files are authoritative. Epicenter checkout files are prepared changes until
Push. Matter checkout integration remains unbuilt and must not enable body or
protected-field writes. File watching does not promise conflict-free simultaneous
filesystem edits or automatically execute a checkout's config.

Both live-store SQL and working-file SQL are optional derived read surfaces in
the target architecture. Neither supplies a second write path. Matter currently
creates its mirror with its vault; optional composition is still implementation
work.

**A custom graphical app is optional; an explicit definition and running owner remain necessary for a store.**

A developer may define and provision a headless project without building a
custom UI. Its host must obey the same persistence exclusion and authorization
rules as a graphical app. This does not choose a daemon, require the desktop app
to remain open, or permit the CLI to start a competing replica. Until admission
and lifecycle are specified, Pull and Push require an existing running owner.

Provisioning an empty store is not a complete authoring workflow. Initial
population, row creation and deletion, and body authoring need their own
contract: the current proposed Push workflow refuses added or removed rows and
body edits. A headless project must not bypass those restrictions through an
implicit import or a second agent mutation API.

The materialization manifest identifies the fixed destination and baseline.
The definition ID alone is insufficient; ownership and remote server identity
also matter. Authentication supplies access, not permission to retarget a
checkout after an account switch. The root `epicenter.config.ts` supplies only
the validation lens, not destination selection. It is ordinary executable code;
validation requires its dependencies and reports import failures normally.
Plain file browsing requires neither config execution nor a running owner.

The developer owns the lens shipped by an app; the folder author owns the lens
used by their tooling. They may change either without migrating stored data or
forcing other consumers to adopt it. Conformance is local to that interpretation.
Config changes cannot grant mutation permission. There is no generated schema,
automatic regeneration, schema-adoption protocol, or Desktop config scanner.
Definition package distribution remains separate work; the existing private
workspace packages are not a public package catalog.

**Portable access and transfer into another app are separate capabilities.**

Any compatible generic tool can interpret the files. A specialized receiving app
owns its supported import mapping and resulting identities. Push remains bound
to the originating destination and baseline. Importing into another app neither
retargets that checkout nor installs the source app's schema and behavior.

Complete transfer requires attachment payloads and relationship handling. A
private blob ID alone is not a portable recording. These contracts remain open;
metadata access must not be described as a complete recording export.

## Consequences

One file interpretation can serve Matter, editors, and scripts. Apps retain
their specialized behavior. This direction requires neither an interactive
schema designer nor a runtime app loader, mandatory type generation, universal
import mapper, or server catalog.

The cost is explicit boundaries: file edits require Push to reach a store;
specialized imports support declared mappings; validation executes authored
code with installed dependencies. Arbitrary folders do not automatically become supported
application data.

The first integration should prove one existing recording's permitted metadata
can travel through Pull, a Matter or script edit, and Push with durable success
and explicit reconciliation after interruption.
That exercise does not require native persistence migration, shared membership,
headless provisioning, or SQL. The subordinate records own those detailed
contracts; this record supplies their composition boundary.

## Implementation order

First finish config-driven validation using the existing compiler and shared
parser, removing the abandoned portable-schema draft. Then establish the owner's
permitted-field contract and replace live-store conflict planning with baseline
field differences. Prove durable success and refusal after interrupted operations
before connecting the existing owner to the first app and CLI workflow. The first
end-to-end edit can use an ordinary script. Matter UI integration and indexing
follow independently. No step requires a new server authority, native migration,
live SQL, or shared membership.

## Considered alternatives

- Every app defines its own file format: duplicates interpretation and prevents
  a generic editor from operating on the same files.
- Every schema describes an executable app: confuses field structure with
  workflows, capabilities, codecs, and authorization.
- Every editor owns a live replica: introduces competing persistence owners
  where prepared files and owner-routed Push suffice.
- Every folder is automatically synchronized: removes the standalone file
  workflow and hides when prepared edits become store mutations.

## Verification

Demonstrate one recording edited through a script producing only its permitted
Push changes. Matter must produce the same edits when its integration lands.
Untouched fields must remain untouched, dirty
Pull must preserve prepared edits, and interrupted Push must block blind retries
and preserve files for explicit reconciliation. Body edits must refuse before
mutations. Config changes must produce no writes, permission changes, or retargeting.
A standalone Matter folder must remain usable without an Epicenter owner.
Check headless admission, initial population, and attachment
transfer separately before claiming those workflows exist.
