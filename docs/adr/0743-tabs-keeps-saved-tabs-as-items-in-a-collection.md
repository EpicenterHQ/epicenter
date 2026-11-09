# 0743. Tabs keeps saved tabs as items in a collection

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Supersedes:** [ADR-0724](0724-a-browser-extension-keeps-its-data-in-a-document.md) (a browser extension keeps its data in a document): a saved tab is kept, so it is an item ([ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md)), and the extension writes it through the local engine ([ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md)).
- **Relates:** [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names from the site's host), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (contracts and `timeId()`), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema).
- **Unbuilt:** all of it: `apps/tabs`, its WXT build, its contract, and its site.

## Context

[ADR-0724](0724-a-browser-extension-keeps-its-data-in-a-document.md) made
Tabs the first document app. Open tabs were read live from the browser.
Saved tabs were items in a Tabs document (url, title, savedAt), kept in a
local document while signed out and merged into `<account>/tabs` on sign-in.
Export wrote one `saved/<id>.md` note per item.

A person saves a tab to come back to it, often weeks later. By
[ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md)'s test
that is kept data, and kept data is items.

## Decision

**Tabs is a collection of saved tabs.** Its contract has one collection:

```txt
{ collections: {
    tabs: { path: 'tabs/{id}.md',
            fields: { url:     { type: 'string', format: 'uri' },
                      title:   { type: 'string' },
                      savedAt: { type: 'string', format: 'date-time' } },
            required: ['url', 'title', 'savedAt'] } } }
```

The folder is named from Tabs's site
([ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)): at
`https://tabs.epicenter.so`, `~/Epicenter/tabs`, and an item is
`~/Epicenter/tabs/tabs/<id>.md`.

**Saving a tab closes it and creates one item, `tabs/<id>.md`.** The id is
`timeId()` (`packages/definition/src/ids.ts`), the moment of the save plus
eight random characters. It is not the URL: the same URL may be saved twice,
and a URL makes a bad file name, with `/`, `?`, and lengths past a file
system's limit.

**Open tabs are the browser's and are not stored.** The extension's panel
reads them from the browser's tabs API to search and close them.

## Consequences

- Saved tabs are files: `grep`, `git log`, an agent's file tools, and the
  Epicenter app reach them like any folder's items.
- Tabs needs no document sync service; its folder syncs through Git like
  every other.
- The same URL saved twice is two items. Removing duplicates is a person's
  or an agent's choice.
- A file name says when a tab was saved, not what it is; the `title` field
  does.
- ADR-0724's local document, its merge into `<account>/tabs` on sign-in, and
  the extension's own grant are gone.

## Considered alternatives

- **Keep Tabs a document (ADR-0724).** Saved tabs are kept data, and a
  document keeps them out of Git and agents' file tools.
- **The URL, or a hash of it, as the id.** Two saves of one URL collapse
  into one item, and a URL is a poor file name.
- **Store open tabs.** They are the browser's current state, change every
  few seconds, and are worth nothing a year later.
