# 0810. A folder needs no app, and a repository is a space's named folder

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0809](0809-a-repository-is-a-spaces-app-and-bytes-nothing-needs-are-collected-or-purged.md) at `/spaces/<space-id>/apps/<app>` and the manifest's `{ space, app }`: a repository is `/spaces/<space-id>/folders/<name>`, and the manifest stores `{ space, name }`; [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at the app writing `epicenter.json`: an app owns it when it names the app's contract, and a person owns it otherwise.
- **Relates:** [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) (the library shows every folder as tables), [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) (tools from a folder's contract), [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) (Normalize), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (an app's names derive from its site).
- **Unbuilt:** all of it: `name` in `epicenter.json`; routes at `/spaces/<space-id>/folders/<name>`; `epicenter init` and `epicenter infer`; the library and `epicenter mcp` serving folders no app owns; an app adopting a folder by naming its contract.

## Context

A folder is an Epicenter folder because it holds `epicenter.json`
(ADR-0805), and everything Epicenter does with one (checking, normalizing,
the library's tables, `epicenter mcp`, sync) reads that file, not an app.
ADR-0809 still addressed a repository by an app, so a folder a person made
themselves, such as a reading list of Markdown notes, could not sync, though
nothing else about it needed an app.

## Decision

**A folder needs no app.** Any folder that holds `epicenter.json` is checked,
normalized, shown as tables in the library, served to agents by
`epicenter mcp`, and synced, whether an app made it or a person did.

**`epicenter.json` names the folder.** Its `name` is the folder's identity on
the server, and a repository is addressed as
`/spaces/<space-id>/folders/<name>`; the manifest stores `{ space, name }`. An
app writes the name derived from its site, so Todos' folder is `todos`. A
person chooses it when they make the folder. Renaming the folder on disk
changes nothing; changing `name` makes a new repository.

**Who owns `epicenter.json` is whether it names an app's contract.** With an
app's `$id`, the app writes it and keeps it current. Without one, it is the
person's, edited by hand, by `epicenter infer`, or by an agent. An app may
later adopt a folder whose shape it understands by naming its contract there.

**A person or an agent starts a folder from the command line:**

```sh
epicenter init        # epicenter.json (name from the folder) and AGENTS.md
epicenter infer       # collections and fields proposed from the front matter already there
epicenter check       # what does not fit
epicenter normalize   # another tool's YAML into `key: <JSON>`, with a preview
epicenter mcp         # typed tools for the folder's collections
epicenter sync        # the first sync makes the repository in the person's space
```

## Consequences

- A folder of notes becomes an Epicenter folder in two commands, with no UI.
- The library is the interface of every folder no app owns.
- No address on the server names an app; an app is one way a folder is made.
