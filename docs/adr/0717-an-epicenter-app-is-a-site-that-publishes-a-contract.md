# 0717. An Epicenter app is a site that publishes a contract

- **Status:** Superseded
- **Date:** 2026-11-03
- **Superseded by:** [ADR-0723](0723-an-apps-site-is-found-by-convention.md).
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (a browser app is identified by its origin); [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) (a folder's `AGENTS.md` names its contract URL); [ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md) (the slug names folders, repositories and AppData); [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md) (fixed roots); [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) (`~/.epicenter`); [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) (Epicenter browses folders and documents).
- **Unbuilt:** the manifest at `https://<origin>/.well-known/epicenter.json` (the path and key names are the proposed shape); its `downloads` and `skill` keys; Epicenter reading a manifest to offer "Get the app" on a new device; copying a skill to `~/.agents/skills/<slug>/`; actions, whose shape is open.

## Context

Each first-party app publishes its contract at its own site, for example
`https://whispering.epicenter.so/contract.json`, written by the app's
<!-- doc-path-check: ignore-next-line (an app-relative path; the full path follows it) -->
`scripts/write-contract.ts` (`apps/whispering/scripts/write-contract.ts`).
A contract carries only `name`, `collections`, `description` and `$schema`;
`compileContract` refuses any other key (`CONTRACT_KEYS`,
`packages/definition/src/contract/contract.ts`).

The contract's `name` is a slug such as `whispering`. [ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md) makes it the
name of an app's folder, repository and AppData directory. A slug is short,
and every program knows it without a lookup, but it is not globally unique:
two third-party apps can both call themselves `notes`.

Nothing tells a new device where to get an app. A person who signs in to
Epicenter sees `<account>/whispering` and has no link to Whispering itself.
Agent skills for an app's data have no published source either.

ADR-0686 and ADR-0687 once made a site URL the unit Epicenter downloaded,
hosted and opened data for. ADR-0701 superseded both: Epicenter hosts and
opens no site. ADR-0614 still identifies a browser app by its origin for
grants.

## Decision

**An app's identity is its site's origin, and its slug is its short name.**
`https://whispering.epicenter.so` identifies Whispering everywhere identity
matters. The slug `whispering` names its folder, repository and AppData
directory ([ADR-0710](0710-an-apps-slug-names-everything-a-program-reads.md)). Two apps may share a slug; their folders then meet at the
collision check ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)), and each folder's `AGENTS.md` still names its own
contract URL ([ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md)).

**The site publishes a manifest whose one required field is the contract.**
The proposed shape:

```txt
https://whispering.epicenter.so/.well-known/epicenter.json
{
  "contract": "https://whispering.epicenter.so/contract.json",   required
  "downloads": { "macos": "<url>", "windows": "<url>" },          optional
  "skill": "https://whispering.epicenter.so/SKILL.md"             optional
}
```

`contract.json` stays where it is and keeps its keys. A web-only app omits
`downloads`. Actions are a later key whose shape is open.

**A folder leads to its app through its contract URL.** A new device follows
one chain, with no registry in it:

```txt
account  ->  <account>/whispering  ->  AGENTS.md contract:  ->  origin
         ->  /.well-known/epicenter.json  ->  downloads, skill
```

**A third-party app joins by publishing.** Epicenter keeps no list of apps; any
site that serves a manifest with a contract is an Epicenter app.

**One-click skill install copies the manifest's `skill`.** Epicenter writes it
to `~/.agents/skills/<slug>/SKILL.md`, the user-level location agent clients
read.

**Epicenter installs no app.** People install apps through Homebrew, an app
store, or the app's site. `epicenter install <url>` is deferred; ADR-0701
refused an Epicenter installer, and a later `install` would at most open the
manifest's download link.

## Consequences

- Third-party apps get a unique identity without asking Epicenter for a name.
- "Get the app" on a new device costs one manifest fetch per repository.
  Offline, a folder still opens, because `AGENTS.md` holds the contract URL
  locally.
- A site that stops serving its manifest leaves its folders readable; Epicenter
  only loses the download link and skill.
- The manifest is a published format with versions to keep. Its required part
  is one key so a site stays cheap to publish.
- Two folders can carry the same slug. Renaming either folder or repository
  changes nothing about identity, which lives in `AGENTS.md`.

## Considered alternatives

- **The slug as global identity.** Third-party apps that choose the same slug
  would collide in folders, repositories and grants.
- **A registry of apps inside Epicenter.** It needs an owner and approval, and
  ADR-0701 refuses an app registry.
- **`downloads` and `skill` inside `contract.json`.** That mixes distribution
  with the shape of data, and `compileContract` refuses keys beyond the four.
- **`epicenter.json` at the site root.** The name belongs to the folder file
  that decision 35 retired (ADR-0700); reusing it would make two meanings for
  one name.
