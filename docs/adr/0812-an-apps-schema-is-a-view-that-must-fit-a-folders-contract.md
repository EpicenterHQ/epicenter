# 0812. An app's schema is a view that must fit a folder's contract

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at `$id` marking an app that keeps the contract current: no app owns a folder's contract, and `epicenter.json` holds no `$id`; [ADR-0810](0810-a-folder-needs-no-app-and-a-repository-is-a-spaces-named-folder.md) at an app owning `epicenter.json` when it names the app's contract: the folder's people own it; [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at `$id` being the contract's URL on the app's site: an app's schema stays at its site, and a folder's contract records no app.
- **Relates:** [ADR-0796](0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md) (a write changes only the fields it names), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema), [ADR-0807](0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md) (the web's first run).
- **Unbuilt:** all of it: the fit check in `@epicenter/definition`; attaching an app checking fit and proposing additions; an app opening a folder through its view; the web's and the desktop's first run offering to create a folder or use one that fits; removing `$id` from `epicenter.json`.

## Context

ADR-0811 let one app own a folder's contract by writing its `$id` into
`epicenter.json`, which assumed one app per folder. A folder people share,
such as a family's "Ancestry", may be used by a family-tree app, a photo
gallery, and the library at once, and an app that owned the contract could
rewrite collections another app reads. An app's code already compiles in the
collections and fields it reads and writes, and a write changes only the
fields it names, so an app never needs the whole contract, only the part it
uses.

## Decision

**A folder's contract is the folder's.** Its people own `epicenter.json`, and
no app writes `$id` or takes it over.

**An app's schema is a view.** An app publishes, at its site, the collections
it reads and writes and the fields it uses. It fits a folder when each of its
collections is in the folder's contract at the same path and each field it
uses is there with a type its own accepts. A folder's other collections and
fields are none of the app's business; it ignores them and its writes leave
them as they are.

**Attaching an app checks fit, and proposes what is missing.** A collection or
field the app needs and the folder lacks is offered as an addition the person
accepts. An app adds; it never removes or retypes what is there. A field the
folder holds with a type the app cannot read is shown as a mismatch, and the
app does not attach until a person changes one or the other.

**Many apps may use one folder**, each through its view; the library and
`epicenter mcp` use the whole contract.

**App-first and folder-first meet in one state.** Making a folder for an app
starts its contract as exactly the app's view. Attaching an app to an existing
folder checks fit and adds what is missing. A first run on the web or the
desktop with no folder attached offers to create one or to use one of the
person's folders that fits.

## Consequences

- A folder outlives every app that uses it, and no app can break another's
  collections.
- An app opens with only the part of a folder it understands.
- A folder's contract grows as apps are attached, and shrinks only by a
  person's edit.

## Considered alternatives

- **One app owning a folder's contract:** simple for one app, and a second app's
  collections are at the first's mercy.
- **An app rewriting the contract to its own on attach:** every attach could
  remove another app's fields.
