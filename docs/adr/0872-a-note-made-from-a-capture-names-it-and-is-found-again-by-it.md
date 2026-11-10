# 0872. A note made from a capture names it and is found again by it

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0869](0869-a-body-is-changed-by-quoting-the-passage-it-replaces.md) (body edits), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (an action and its commit), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (apps and their files), [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (personal software).

## Context

An agent can read a capture and develop it into a note. Retrying that work
must find the note it already made, including when two calls arrive together.
The capture remains a record of what was captured.

## Decision

A note made from a capture keeps the capture's path in a readOnly `capture`
field and lives at `notes/capture-<capture name>.md`. Notes' `add` checks every
note's `capture` first, so it also finds a note written by hand at another
path. It returns the existing note with `added: false` without changing it.
Collection `add` refuses an existing path, so concurrent retries meet at the
same file; the refused caller reads and returns it.

The agent reads the capture with `capture_get` and writes the developed note
with `notes_add`. Notes never reads or writes Capture and has no move or
summary action. The capture is unchanged and its history does not advance.

## Considered and not chosen

- A uniform `notes/<time>.md` with only a scan: two concurrent retries could
  both write a note.
- A cross-app Move to Notes action: one app would write another's files and
  the move would need two commits.
- A generic `source` field naming any app: there is no second source yet.
- Letting `set` change `capture`: retries need a stable source. A person can
  still edit the file by hand.

## Consequences

Deleting the note lets a later `add` make it again. Notes depends only on
Capture's path shape, `captures/<name>.md`, without importing Capture's code.
