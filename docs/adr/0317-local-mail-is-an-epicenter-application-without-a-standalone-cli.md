# 0317. Local Mail is an Epicenter application without a standalone CLI

- **Status:** Accepted
- **Date:** 2026-08-31
- **Unbuilt:** starting Local Mail's window hidden, so a person who has not launched it still has a current mailbox. Withdrawn by ADR-0323, which measured a hidden window being suspended and moved the work into the host instead. What is unbuilt is now the host-side half rather than a hidden window. Not a worker: ADR-0273 decided a hidden window is the application itself rather than something running beside it, and the word `worker` here contradicted the record this depends on. The rest is done: the hosted application, its migration onto the scoped handle, and the deletion of the standalone Bun/Tauri runtime and human CLI. Closing the window does not stop synchronization and never did (`src-tauri/src/lib.rs` intercepts the close and hides); what stops is quitting Epicenter, after which nothing runs until somebody launches the application by hand.
- **Amends:** [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) at Local Mail's artifact naming, [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) at the word "sibling", and [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) at the ownership mechanism. Each of those records carries the withdrawal in its own header.
- **Relates:** [ADR-0082](0082-local-mail-syncs-by-push-free-history-list-polling.md) (the provider synchronization method), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (desktop secrets and background synchronization), and [ADR-0316](0316-an-application-creates-one-scoped-epicenter-handle.md) (the application-facing capability handle)

## Context

Local Mail currently has a Bun runtime, a Tauri shell, a human CLI, an HTTP
API, and a browser UI. That split keeps a second storage owner and a second
credential path alive beside the Epicenter application handle. The product
needs one application lifecycle, with desktop background synchronization and
browser synchronization while the application is open.

## Decision

Local Mail is hosted as a first-party Epicenter application. It has no human
CLI and no standalone Bun/Tauri runtime. The visible application and its
desktop-only hidden synchronization worker use the one scoped `createEpicenter`
handle for data, SQLite, secrets, and mirrors; Local Mail owns Gmail semantics,
OAuth, refresh, reconciliation, and account consent. Browser synchronization
runs while the application is open. An MCP surface may be added later as a
separate application-facing integration, but this decision adds no compatibility
path for it.

## Consequences

- The human workflow is UI-only: connect, inspect status, reconcile, and manage
  account actions through Local Mail.
- `credentials.json`, standalone runtime discovery, the Local Mail Tauri shell,
  and the old per-account database openers are deleted rather than maintained
  beside the scoped handle.
- Desktop background work belongs to the hidden application worker; the host
  provides capabilities but does not own Gmail meaning.
- A future CLI or MCP integration must enter through an explicitly designed
  application service. Neither is part of the current storage contract.
- Arbitrary SQL query access and command-line-only recovery affordances do not
  survive this clean break. Product workflows that remain necessary must earn a
  UI or application API.

## Considered alternatives

- **Keep the standalone runtime and remove only the CLI.** Rejected because the
  standalone runtime would still preserve a second storage and credential owner.
- **Keep the CLI as a thin client.** Rejected for now because it still requires
  a supported headless transport, lifecycle, and error contract without a
  current product need.
- **Add MCP now.** Deferred until an agent workflow requires a stable surface.
