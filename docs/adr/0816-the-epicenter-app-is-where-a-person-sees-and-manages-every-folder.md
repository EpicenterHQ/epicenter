# 0816. The Epicenter app is where a person sees and manages every folder

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0790](0790-the-epicenter-app-is-a-library-over-every-folder-and-the-cli-answers-its-queries.md) and [ADR-0815](0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md) at "the library": the app is called Epicenter, and "library" leaves the vocabulary; [ADR-0800](0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md) at "Connect your agents" in apps and the library: it lives in the Epicenter app, which also shows which agents are connected.
- **Relates:** [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) (folders and lenses), [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) (sharing), [ADR-0809](0809-a-repository-is-a-spaces-app-and-bytes-nothing-needs-are-collected-or-purged.md) (purge), [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (the CLI composes the same packages).
- **Amended by:** [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) at its jobs: it also keeps every folder in sync, and opens a folder in any app that fits.
- **Unbuilt:** the Epicenter app's window over any folder, its views across folders, purge, repair, and "Connect your agents"; "library" removed from code, docs, and `docs/CONTEXT.md`, and `~/Epicenter` called the Epicenter folder.

## Context

The app that shows every folder was called the library, a word that means a
code package to a developer and a shelf of books to a person. It is the home
of every folder, a lens that opens any of them, and the place where folders are
managed: a document is a folder here, as a macOS document bundle is a folder
shown as one document, and this app is where a person finds and handles them.

## Decision

**The app is Epicenter.** A person opens Epicenter and sees their folders; code
and docs call it the Epicenter app. `~/Epicenter` is the Epicenter folder.

**It is where a person sees and manages every folder:**

| Job | What it does |
| --- | --- |
| see | every folder in the Epicenter folder, with its title, members, and state: never synced, synced, or shared |
| open | a folder as tables of its collections, filtered by `select * from <collection> where …` and edited by field type, or as its files; its history |
| manage | sync, share and unshare, accept folders shared with the person, purge audio only history holds, repair notes that do not read |
| across folders | search and queries over every folder |
| agents | "Connect your agents": install the `epicenter` command, add `epicenter mcp --all` to an agent's configuration, and show which agents are connected |

It runs no MCP server; an agent starts `epicenter mcp` itself.

**The command line is the same platform without windows**, for terminals and
agents, composing the same packages: `sync`, `init`, `check`, `log`, `diff`,
`restore`, `clone`, `share`, `query`, `set`, and `mcp`.

**A folder is shared wherever it is shown:** in the Epicenter app, in an app's
home, and by `epicenter share`. A share a person accepts lands in the Epicenter
folder beside their own.

## Consequences

- The product's name is the app a person opens to see their things.
- Agents are connected from one place.
