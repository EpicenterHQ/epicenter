# 0951. The command reaches serve through a socket file in the root

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0936](0936-one-serve-per-home-runs-every-action.md) on how a command finds its serve and how a second Epicenter's command is kept out.
- **Relates:** [ADR-0927](0927-serve-listens-only-on-this-computer.md) (who reaches the port), [ADR-0950](0950-home-is-retired-the-folder-is-your-epicenter-and-root-in-code.md) (the root), [ADR-0952](0952-epicenter-does-nothing-about-upgrades.md) (the version header).
- **Unbuilt:** all of it.

## Context

The `epicenter` command sends each call to serve over HTTP at
`127.0.0.1:<port>`, the port in `EPICENTER.md`. A port belongs to the whole
computer, and two folders can name the same one: a copy of an Epicenter carries
its `EPICENTER.md`. So identity rides in a header. The command sends
`x-epicenter-home` with the root's real path, serve refuses a call meant for
another folder with 409, and serve stamps the same header on every answer so
`whoAnswers` can tell its own serve from another Epicenter's or from another
program (`packages/cli/src/serve-call.ts`, `http.ts`). That header puts the
owner's absolute path, including the account name, on every answer, including
those to other devices on the private network.

## Decision

**Serve also listens on a Unix socket file at `<root>/.serve.sock`, and the
command calls through that file. The file in the folder is the address, so the
folder is the identity.**

- A command in a copy reaches the copy's socket, or no file. It cannot reach
  another Epicenter's serve.
- "Is serve running" is whether the file answers. No file, or a refused
  connection, means it is not.
- On start, serve refuses if the file answers (one is already running for this
  root) and removes it otherwise, since a crash leaves it behind. Serve
  removes it on stop. It is mode `0600`.
- The port stays, for browsers, other devices and MCP clients, with its
  guards unchanged. Both listeners share one handler.
- The root's `.gitignore` gains `/.serve.sock`.

Bun serves on a socket with `Bun.serve({ unix })` and calls one with
`fetch(url, { unix })`; a stopped server removes the file, and a call to it
then fails with `ENOENT` (checked on Bun 1.4.3).

## Consequences

- Removed: the `x-epicenter-home` header in both directions, `homeName()`,
  the 409 for a call meant for another Epicenter, the `OPTIONS` probe and
  `whoAnswers`, and the "port answers for another program" branch in the
  command. No path reaches a header.
- macOS limits a socket path to 104 bytes. A root nested deep enough to
  exceed it cannot start serve; the refusal says to move the folder.
- Linux and macOS only, as Epicenter already is.

## Considered alternatives

- **Keep the header, renamed `Epicenter-Root`, carrying a hash of the root
  path.** It stops the path leaking but keeps a check on every call, a probe,
  and a refusal for a case the socket makes impossible.
- **A random token written to a file at start.** It is state serve writes and
  must clean up, to prove what the socket's location already proves.
- **The command runs actions itself.** ADR-0936 makes serve the one process
  that runs actions; this keeps that.
