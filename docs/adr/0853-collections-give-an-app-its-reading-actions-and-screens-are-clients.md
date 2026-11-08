# 0853. Collections give an app its reading actions, and screens are clients

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at how a collection is viewed: through reading actions it gives the app, not a separate data view. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at what the hub is: a client of `epicenter serve`. [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at Epicenter Cloud's file API, which is not built: a client without Git runs actions instead.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (`serve`), [ADR-0852](0852-epicenter-is-one-contract-and-four-open-slots.md) (the screens slot).
- **Unbuilt:** all of it.

## Context

ADR-0844 planned a hub with an action view and a data view, and ADR-0845 gave
apps collections for the data view to read. A page that only lists actions is
not what a person wants; they want to browse their data and act on it. Agents
want the same reads.

## Decision

**Each collection gives its app two reading actions.** A collection
`words: { path: 'words/{stem}.md', fields }` adds `vocab words list` (every item,
its fields as columns) and `vocab words show <stem>` (one item). They are
`readOnly`, run like any action, and appear in the CLI, over MCP, and to screens.
An app's own actions with the same words win.

**Everything a client sees is an action.** `epicenter serve` offers HTTP and MCP
and nothing else: no file API and no data API beside the actions.

**A screen is a client.** The Epicenter app (a web client in a desktop window, a
phone browser, later a native phone app) browses data through reading actions as
tables and detail views, and runs writing actions as forms. `serve` may host the
web client's files; the client is its own piece.

**A standalone app is a screen for one app.** It ships its own interface and
uses the device it runs on (Whispering's microphone and shortcut), and it runs
that app's actions on your Epicenter; it never runs actions itself and bundles
no Epicenter runtime. What it captures before your Epicenter confirms an action
stays on the device. Without an Epicenter it keeps working on its own, and
connecting to one is a setting.

## Consequences

- An app with collections is browsable and agent-readable with no code beyond
  its declaration.
- Deleted: a separate data view, a file-reading endpoint, and a hub with its own
  runtime.
- A raw "write any file" action does not exist, so an agent cannot bypass an
  app's own actions through a screen.

## Considered alternatives

- **The context as actions (`folder`, `cache`, `secrets` exposed and spread).**
  A generic write lets callers skip an app's rules.
- **A data API beside the actions, or Epicenter Cloud's file API (ADR-0842).**
  Two protocols for one app.
- **A standalone app that runs actions itself**, by bundling the `epicenter`
  binary or reimplementing the commit rule natively. A second runner per app, or
  a second implementation of the rule.
