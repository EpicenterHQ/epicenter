# 0723. An app's site is found by convention

- **Status:** Superseded
- **Date:** 2026-11-03
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Supersedes:** [ADR-0717](0717-an-epicenter-app-is-a-site-that-publishes-a-contract.md) (an Epicenter app is a site that publishes a contract) at its manifest: the site publishes its contract and an optional skill at fixed paths, and no manifest file exists.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app is identified by its origin); [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) (a folder's `AGENTS.md` names its contract URL); [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (an app's names derive from its site's host).
- **Unbuilt:** publishing `/SKILL.md` from any app's site; Epicenter copying it to `~/.agents/skills/<name>/`; Epicenter's "Get the app" opening the origin from a folder's `AGENTS.md`.

## Context

Each first-party app publishes its contract at its origin, for example
`https://whispering.epicenter.so/contract.json`, written by the app's
<!-- doc-path-check: ignore-next-line (an app-relative path; the full path follows it) -->
`scripts/write-contract.ts` (`apps/capture/scripts/write-contract.ts`). A
folder's `AGENTS.md` records that contract URL
([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)),
so the folder already leads to the app's origin.

[ADR-0717](0717-an-epicenter-app-is-a-site-that-publishes-a-contract.md)
added a manifest at `https://<origin>/.well-known/epicenter.json`. Its one
required key, `contract`, repeated the URL `AGENTS.md` already holds, and its
optional keys (`downloads`, `skill`) were links a fixed path or the site
itself can carry.

## Decision

**An app is a site that publishes `/contract.json` at its origin.** The
origin is the app's identity
([ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md)); its host
names the app ([ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)).

```txt
https://whispering.epicenter.so/
  contract.json        required: the app's contract
  SKILL.md             optional: an agent skill for the app's data
  (the site itself)    how to get the app
```

- **`/SKILL.md` is optional.** When present, Epicenter's one-click skill
  install copies it to `~/.agents/skills/<name>/SKILL.md`, where `<name>` is
  the app's derived name.
- **"Get the app" opens the origin.** A new device goes from the account's
  repository, to its `AGENTS.md`, to the contract URL's origin, which the site
  serves as its download page.
- **No manifest file exists.** No `/.well-known/epicenter.json` and no
  `downloads` or `skill` keys.
- **No registry exists.** A third-party app joins by publishing
  `/contract.json` at its own origin.

`epicenter install <url>` stays deferred: apps install through Homebrew, app
stores, or their site. How an app publishes actions is an open question.

## Consequences

- A developer publishes one required file and, if they want, one more; there
  is no format to version.
- Epicenter derives every lookup from an origin it already has: the contract
  at `/contract.json`, the skill at `/SKILL.md`, the download page at `/`.
- Download links are for people, on the site, not machine-readable per
  platform; Epicenter cannot install an app by itself.

## Considered alternatives

- **The manifest of [ADR-0717](0717-an-epicenter-app-is-a-site-that-publishes-a-contract.md).** Its only required key repeated `AGENTS.md`, and its optional keys are links a fixed path or the site can serve.
- **Download and skill keys inside `contract.json`.** Mixes how an app is distributed with the shape of its data; the contract refuses keys beyond `$schema`, `name`, `description` and `collections` (`packages/definition/src/contract/contract.ts`).
