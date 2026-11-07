# 0817. The CLI exposes every platform operation, and an app inherits everything about folders

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Relates:** [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) (programs only compose), [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (programs never call each other), [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) (folders and lenses), [ADR-0815](0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md) (a window's folder and the home), [ADR-0816](0816-the-epicenter-app-is-where-a-person-sees-and-manages-every-folder.md) (the Epicenter app), [ADR-0799](0799-a-folders-contract-is-also-an-mcp-server.md) (MCP from a contract).
- **Amended by:** [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) at "a command here": an operation is a package function and one description, which the CLI and `epicenter mcp` both render.
- **Amended by:** [ADR-0828](0828-names-say-folders-and-changes-and-history-is-package-functions-the-epicenter-app-shows.md) at the Unbuilt "history": history is package functions, and the Epicenter app shows a folder's history and imports from Git.
- **Unbuilt:** a command for each platform operation that lacks one; the platform's pieces an app places in its window (history, share, the marks, repair).

## Context

Folders work with no app (ADR-0813), and each platform operation (sync,
history, sharing, checking, querying, repairing) is code in a package that
programs compose (ADR-0793). Agents work through the command line and MCP,
people through windows, and an app that wrote its own sync, history, or
sharing would make each behave differently from app to app.

## Decision

**Every platform operation is a function in a package, and the command line
exposes every one.** The CLI is the platform's complete presentation; the
Epicenter app and every app are others, over the same functions, and none of
them calls the CLI. An operation without a command is not yet a platform
operation. Each operation is built as a package function and its command
first, and given a window after.

**An app inherits everything about folders, and owns its view.**

| The platform's, inherited | The app's |
| --- | --- |
| finding folders, the home, New and Open | its view: the collections and fields it uses |
| one window per folder | its window's interface |
| sync, its moments, and the marks | its capabilities: a recorder, AI, shortcuts |
| history: versions, the timeline, restore | its settings on this computer |
| sharing and accepting | the hosted features it signs in for |
| conflicts and repair | |
| the fit check and the additions it proposes | |
| signing in to sync | |
| agents' access, through MCP from the contract | |

An app places the platform's pieces (a history panel, a share button, the
marks) where its layout wants them, and does not replace them. The Epicenter
app coordinates no other app; it is set apart only by what it shows.

## Consequences

- An agent can do through the command line or MCP whatever a person can do in a
  window.
- History, sharing, sync, and conflicts look and behave the same in every app.
- An app developer writes no sync, history, or sharing, and cannot get them
  wrong.
