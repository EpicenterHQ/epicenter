# 0421. Apps and file tools compose around explicit stores

- **Status:** Proposed
- **Date:** 2026-09-21
- **Unbuilt:** Independent store composition, owner-routed working copies, faithful Matter schema mapping, and headless project provisioning. Host admission, initial record creation, schema upgrades, and complete attachment transfer remain unresolved.

## Context

Whispering gives recordings a specialized interface. Matter gives typed Markdown
folders a generic table interface. A person should be able to work with the same
supported data through an app, Matter, an editor, or a script without each tool
inventing its own storage and schema interpretation.

The current `packages/app/src/open.ts` couples stores to one App lifetime.
Matter's `createVault` discovers table folders through `matter.json` and follows
file changes. These provide parts of the target, but do not yet implement a
shared app-to-working-copy workflow. A portable schema also does not transport
the originating app's behavior.

## Decision

**Apps and file tools compose around explicit stores and one portable file contract.**

A definition declares a store's stable ID, tables, and KV. A host is the process
or browser context that runs its local replica and owns persistence. An app
composes store handles and product behavior. Matter interprets portable table
folders. The CLI routes working-copy operations to the identified host.

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
| CLI | Destination discovery and owner-routed Pull/Push |
| SQL projection | Derived reads with a stated source and freshness |

[ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md)
describes independent stores for explicit local, personal, and shared owners.
An app opens only the stores it needs. A definition can be reused across owners
without making those stores the same data. No mandatory runtime aggregate is
needed merely to collect their handles.

[ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) describes
Push as permitted field differences against a durable checkout baseline.
Apps edit their live stores. People and agents edit working files and submit
through Push. Scripts that edit files do not acquire a second persistence owner.
Baseline and recovery state are not disposable query caches.

[ADR-0420](0420-epicenter-working-copies-use-the-matter-file-contract.md) describes
the shared file contract and generated per-table schemas. Standalone Matter
files are authoritative. Epicenter checkout files are prepared changes until
Push. Opening a checkout in Matter does not enable body or protected-field
writes. File watching keeps the display current; it does not promise conflict-free
simultaneous filesystem edits.

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

Project configuration identifies an explicit destination. The definition ID
alone is insufficient; ownership and remote server identity also matter.
Authentication supplies access, not permission to retarget a checkout after an
account switch. Whether configuration is JSON or executable TypeScript, its
filename, and its loading rules remain open. Browsing portable data must not
require executing project code.

The developer owns an app's definition; a headless project author takes that
role for their project. Generated checkout schemas describe the receiving
contract and cannot migrate it. Schema adoption and upgrades, including older
clients, require an explicit policy. A catalog may publish definitions without
being required for local creation or becoming a second schema authority.

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
specialized imports support declared mappings; schema upgrades require a
developer decision. Arbitrary folders do not automatically become supported
application data.

The first integration should prove one existing recording's permitted metadata
can travel through Pull, a Matter or script edit, and Push with durable recovery.
That exercise does not require native persistence migration, shared membership,
headless provisioning, or SQL. The subordinate records own those detailed
contracts; this record supplies their composition boundary.

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

Demonstrate one recording edited through Matter and through a script producing
the same permitted Push changes. Untouched fields must remain untouched, dirty
Pull must preserve prepared edits, and interrupted Push must recover without
repeating intent. Generated-schema and body edits must refuse before mutations.
A standalone Matter folder must remain usable without an Epicenter owner.
Check headless admission, initial population, schema upgrades, and attachment
transfer separately before claiming those workflows exist.
