# 0923. A write to front matter replaces only the lines of the keys it changes

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. `withFields` in `packages/app/src/front-matter.ts` rewrites a YAML block whole.

## Context

Front matter is written as `key: <JSON>` lines, and a write to such a file
already replaces only the lines of the keys it changes. YAML front matter is
read too, and the first write that changes a field rewrites the whole block
as `key: <JSON>` lines.

That rewrite changes lines the caller did not name. It drops a comment line,
requotes every bare scalar, and turns a block list into one line. One large
folder holds 3,323 pages, every one with YAML front matter, 2,962 of them
with a bare `title` and all of them with a bare `timezone`. One `set` of one
field reformats the file a person wrote.

## Decision

**A write to a YAML block replaces the lines of each key it changes, and leaves every other line as it is.**

A top-level key's lines run from its own line to the line before the next
top-level key or the closing fence. The write puts `key: <JSON>` in their
place, which YAML reads as the same value. A new key is added before the
closing fence. A removed key's lines are deleted.

**When a key's lines cannot be found that way, the write is refused.**

A block that uses an anchor, an alias, or a top-level key spread in a way the
rule does not cover is left alone, and the refusal names the path and the
key. A person or an agent changes that file as text.

There is no pass that converts a folder's YAML to `key: <JSON>` lines.

## Consequences

- A file a person wrote in YAML keeps its comments, its quoting, and its
  block lists through every write that does not name them.
- A file becomes mixed: the keys the app has written are `key: <JSON>`
  lines, and the rest stay as written. Both are YAML.
- A row of objects the app writes, such as a page's `posts`, becomes one
  line the first time the app changes it.
- The whole-block rewrite and its fallback are deleted. A line-range finder
  for YAML replaces them.

## Considered alternatives

- **Rewrite the block, as today.** It changes what a person wrote without
  being asked.
- **Convert a folder once, on purpose.** It still rewrites every file, and
  leaves a person's YAML habits with nowhere to live.
- **Write YAML back out.** It needs a YAML writer that keeps comments and
  layout, for a format the app does not choose.
