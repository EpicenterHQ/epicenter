# 0330. An agent uses the surfaces a person uses

- **Status:** Accepted
- **Date:** 2026-09-01
- **Relates:** [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) (the surface an agent edits through), [ADR-0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md) and [ADR-0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md) (the read-only query surface this adopts), [ADR-0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) (where MCP belongs)
- **Unbuilt:** the edit surface waits on ADR-0329. Matter's `query_mirror` was the one built read surface, and it was deleted with Matter (ADR-0534). Nothing named here is new; what is unbuilt is Epicenter having them.

## Context

An agent is becoming a primary editor of a person's data rather than an
assistant beside it. "Point your agent at `~/Epicenter`" has been the stated
product since ADR-0207.

The obvious move is to give it its own surface: a mutation API, a tool schema, a
set of typed row operations. That is a second write path, and a second write path
has to be designed, versioned, documented, permissioned, and kept correct
against the first one forever, for a consumer that is unusually good at the
surfaces that already exist.

## Decision

**An agent reads with SQL, edits with markdown, and builds with TypeScript.
There is no fourth surface and no agent-specific API.**

```txt
  to read     SQL over a projection built beside the files, opened
              read-only and rebuilt whole, never a write target

  to edit     a row's values, as frontmatter in a file
              the same path an editor, git, and a person use (ADR-0329)

  to build    TypeScript. the agent writes an application that opens
              the store, for the screen a person wanted and nobody
              had built
```

Each of these has a human depending on it, so none of them can quietly rot into
an agent-only path that nobody exercises.

**The read surface is a projection and never a verdict.** It is rebuilt whole
rather than incrementally maintained, opened read-only, and it answers questions
rather than deciding them, exactly as ADR-0026 settled for Matter. It is a new
projection beside the folder, not a revival of the one
[ADR-0269](0269-the-browser-is-the-runtime-so-the-file-opener-the-history-shelf-and-the-sql-projection-are-deleted.md)
deleted, which lived in a host that owned application data.

**An agent has no identity of its own.** It acts as the person, on the person's
machine, over the person's files. What makes its work reviewable is the same
thing that makes anyone's work reviewable: the diff.

## Consequences

- Nothing is built to make an agent a first-class client, because being a
  first-class client is what the three surfaces already are.
- **An agent cannot rewrite prose.** The body is one way (ADR-0329), so an agent
  may propose a rewrite as a file, and accepting it is a deliberate whole-value
  replace on one row. This is a real limit and the one place a person will feel
  it.
- Attribution is by file change, not by author. An agent's edit and a person's
  edit are the same kind of event, and the record of what happened is whatever
  the person's own version control keeps. Epicenter adds no audit log, because a
  log nobody reads is worse than a diff somebody does.
- MCP is unchanged. ADR-0073 makes it the vocabulary for tools a peer exposes,
  with a foreign host receiving read-only tools and never an unapproved
  mutation. Reading a person's rows is not a tool call, so nothing here touches
  that surface. Read ADR-0073 with care: the relay and action mesh it decided
  for predate ADR-0227's clean break, so its world only half exists.
- If a fourth surface is ever proposed, the test it has to pass is whether a
  person would use it. A surface only an agent uses is a surface only an agent
  will notice is broken.

## Considered alternatives

- **A typed mutation API for agents.** Rejected. It is a second write path whose
  only consumer cannot report a bug, and it would need its own permission story
  the moment it existed.
- **An MCP server over the store.** Rejected. ADR-0073 scopes MCP to tools a
  peer exposes and guarantees a foreign host gets read-only ones; a person's
  own rows reached through their own files are not that shape, and wrapping the
  store in MCP would add a protocol between an agent and a directory it can
  already open.
- **An agent identity, so its writes are attributable and revocable.**
  Deliberately deferred rather than refused. It buys real things (who changed
  this, and undo everything that one did), and it costs a second principal in a
  system whose whole identity model is one person per device. Revisit if agents
  begin acting without a person present.
