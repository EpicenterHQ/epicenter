# 0716. Agents edit a document through one-shot CLI commands

<!-- doc-path-check: ignore-file (cites the waiting folder sync product (ADR-0840), kept at tag folder-sync-product) -->

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Relates:** [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md) (documents and the field vocabulary), [ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md) (a document's address), [ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md) (generations), [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) (the Epicenter app opens documents), [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) (the machine's one local copy of each document), [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) (no MCP server, which stands).
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at the document store: the folder is the only kind of store.
- **Unbuilt:** all of it: `epicenter get` and `epicenter set`, the local document copy at `~/.epicenter/documents/<namespace>/<name>/`, its lock, and its sync with the server.

## Context

An agent works on a folder through its files, `git`, and the `epicenter`
CLI (ADR-0578). A document ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)) is a Yjs document synced through the
person's account, not a file, so an agent's file tools cannot reach it.

A machine keeps one local copy of
each document for offline use, at `~/.epicenter/documents/<namespace>/<name>/`
([ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)), which Epicenter and document apps also open.

## Decision

**An agent reads and writes a document with one-shot CLI commands.**

```sh
epicenter get <namespace>/<name> <collection> [<id>] [--json]
epicenter set <namespace>/<name> <collection> <id> <field>=<value>...
```

**Each command loads, applies, sends, and exits.** It opens the local copy
at `~/.epicenter/documents/<namespace>/<name>/`, fetching the document first when there is none, applies the
read or the edit in one transaction, appends the update to the local copy,
and sends it when online. Offline, the update waits in the local copy for the
next sync. No process outlives the command.

**The CLI, the Epicenter app, and document apps share one local copy.** Every
writer appends under one lock per document, the CLI's cross-process lock
(`packages/cli/src/file-lock.ts`), with one lock file per document. Yjs updates
apply in any order; the lock keeps two writers from appending at once.

**`set` validates against the document's fields.** A value its field
([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)) refuses exits nonzero with the reason, and `--json` reports it
the way the CLI's other commands do (`writeJson` in
`packages/cli/src/output.ts`).

**A copy from an older generation ([ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md)) is refused like any other
device's.** The command exits nonzero and names "Discard local copy" and
"Export it as notes".

## Consequences

- Every command pays one load of the document from the local copy. For a
  typical document that is one local read; the cost is unmeasured.
- Agents work offline and get JSON, with no server-side tool surface.
- A bulk edit is many commands, each taking the lock.
- A command waits while the Epicenter app holds the lock.

## Considered alternatives

- **A long-lived handle the agent queries repeatedly.** A background process
  needs its own lifetime, idle timeout, and crash recovery. For a typical
  document, one-shot commands return the same answers.
- **Talking to the running Epicenter app.** Two paths, depending on whether
  the app is running.
- **An MCP server.** Refused by ADR-0578; the CLI reaches every agent with a
  shell.
- **`epicenter checkout` and `epicenter apply`, deferred.** Checkout would
  write a document's items as notes, the agent would edit them with file
  tools, and apply would diff against what checkout wrote and send the
  changes. It gives agents files for bulk edits and refuses bodies that do
  not convert exactly. It waits until one-shot commands prove too narrow.
