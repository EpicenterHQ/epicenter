# 0802. People share spaces, an app works in one at a time, and a folder carries its contract

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at "The noun is team, in code and on screen" and "An app chooses a team at consent": the noun is space, and consent chooses the spaces an app may reach; [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at "names a contract, by URL or by a path in the folder" and "A desktop app's team is a setting in its AppData": the contract is `contract.json` in the folder, and an app's current space is chosen with a switcher; [ADR-0791](0791-a-folders-first-sync-places-it-in-its-teams-folder.md) at a team's folder: a space's folder; [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at the founder's decision on a local repository: the lean is a plain folder, which the prototype confirms or refutes.
- **Relates:** [ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md) (items are what you keep), [ADR-0711](0711-a-folder-names-its-apps-contract-in-a-committed-agents-md-note.md) (the folder's `AGENTS.md`), [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) (tools derived from the contract), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (sync like save).
- **Amended by:** [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at `AGENTS.md` naming `contract.json`: the contract is `epicenter.json`, and `AGENTS.md` names nothing.
- **Unbuilt:** all of it: `team` renamed `space` in the server, the CLI, and the screens (ADR-0770's `namespace` tables become `space` and `space_member`); consent choosing several spaces; an app's space switcher; `contract.json` written and updated by the app, and `AGENTS.md` naming it by path; "note" renamed "item" where it names an entry of a collection; "round" renamed "sync" in code and records that follow.

## Context

People share data with groups that are not companies: a family keeping a book
archive, a couple keeping a shared diary. Each group holds several apps' data,
and a person keeps their own data beside it, so one app (a diary) holds a
person's own entries in one place and a couple's in another. ADR-0770 named
the group a team and let consent choose one; ADR-0772 made a desktop app's
team a setting. The words "note" for an entry of a collection and "round" for
one sync had leaked from code into the model, and a folder named its contract
by a URL an agent or tool must fetch to know the folder's shape.

## Decision

**A group of people who share data is a space.** "Wong Family" is a space, and
so is "Me & Jess"; a person's own data is their space. A space owns one
repository per app, and on a computer each space is a folder under
`~/Epicenter`, a person's own at its top level.

**An app is one kind of thing, and works in one space at a time.** Diary is one
app, whether the entries are a person's or a couple's. The app opens the folder
of its current space and shows a switcher to change it; switching closes that
folder and opens the other. Consent grants the spaces a person chooses, so
switching asks nothing more. The library shows every space at once. An app may
later open several spaces' folders together where a merged view serves it.

**A folder carries its contract.** `AGENTS.md` names `contract.json` by path,
in the folder. The app writes it and updates it, as it writes front matter,
and it syncs with the data; its `$id` is the contract's URL on the app's site.
An agent, a tool, or `epicenter mcp` learns a folder's shape with nothing
fetched.

**The words.** An entry of a collection is an **item**: one Markdown file; any
other file it owns is an attachment. "Note" names Honeycrisp's notes, nothing
in the model. One exchange with the server is **a sync**, for people and code.

**The lean on a local repository is a plain folder.** A computer keeps a
folder's files and a record of what it last synced, and history lives on the
server, reached through `epicenter log`, `diff`, `restore`, and `clone`. Sync is
then the algorithm the web already runs, over a file store. The
store-to-store prototype of ADR-0794 confirms or refutes it before the core is
linked into any app.

## Consequences

- Sharing reads the same for a family, a couple, and a company.
- App code holds one folder at a time; the switcher is the platform's.
- A folder is self-describing offline.
- A person in several spaces sees one at a time in an app, and all of them in
  the library.

## Considered alternatives

- **Team:** accurate for work, stiff for a family or a couple.
- **One app per purpose, such as a separate couple's diary:** an app is
  identified by its site, so the same app could not be installed twice, and
  every purpose would copy an app.
- **Every app showing all its spaces together:** every app's interface would
  hold several folders and ask where each new item goes.
- **The contract by URL, or inline in `AGENTS.md`:** a fetch before a folder can
  be read, or machine JSON in a file people and agents edit as prose.
