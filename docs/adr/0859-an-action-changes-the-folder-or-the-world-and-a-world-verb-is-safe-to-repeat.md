# 0859. An action changes the folder or the world, and a world verb is safe to repeat on the targets it is given

- **Status:** Proposed
- **Date:** 2026-11-09 (amended 2026-11-09: only a person or an agent reruns a world verb)
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at writes outside the folder: an action no longer writes another app's folder, so Mail saves attachments into its own.
- **Relates:** [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (inside the folder, the path is the policy), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (how the folder is committed), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (collection actions), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (the cache).
- **Unbuilt:** `@<file>` for a list field. Mail's synthetic actions are built as described by [ADR-0873](0873-a-mail-label-change-waits-in-intent-local-sqlite-until-reconcile-gmails-only-writer-confirms-it.md).

## Context

Earlier records sorted what an action touches three ways: data the person owns,
caches derived from it, and effects on outside services. The spec's Mail then
grew a mechanism for each: `plan` wrote a batch file, `apply` read it, marked
each line applied so a failed run showed its progress, and `show --attachments`
wrote into the vault's folder on Mail's behalf. Each mechanism answered one case,
and `apply` was the only way to change Gmail, so archiving one message took the
same three steps as archiving three thousand.

## Decision

**An action changes the folder, the world, or both.** The folder is what Git
can see; the world is everything Git cannot undo.

```txt
the folder   the app's files     what each path becomes is ADR-0858's: tracked
                                 paths are history, .local paths stay on this
                                 computer, .cache/ is rebuilt
the world    Gmail, a server     keeps its own state; undone, if at all, by the world
```

What a write in the folder becomes belongs to its path (ADR-0858), not to the
action, so an action never names it.

**A verb that changes the world acts on explicit targets and is safe to repeat
when its effect allows it.** Mail's `label` now asserts desired labels in a
durable local store; `reconcile` is the only verb that changes Gmail and can
repeat an assertion safely (ADR-0873). A failed delivery leaves the assertion
for the next pass. Only a person or an agent asks for another pass; Epicenter
does not rerun it on its own. A verb that cannot repeat safely, such as
Messages `send`, keeps its own record and blocks a retry until a person
resolves an uncertain outcome (ADR-0874).

**A reviewed batch can be a file of targets, read by the same verb.** The
proposed list-field syntax
accepts `@<file>`, the lines of that file with `#` comments removed:

```sh
epicenter mail label 18f2a9c0e1d4b7a3 --remove INBOX
epicenter mail label --ids @batches/newsletters.md --remove INBOX
```

Mail has no `plan` or `apply`. A batch would be the person's file like any other:
`batches/newsletters.md` travels, and `batches/newsletters.local.md`, which
lists other people's names and subjects, stays on this computer (ADR-0858).

**An action writes only its own app's folder.** Mail's current actions do not
save attachments. If it gains that action, it writes under `mail/`; another
app reads from there or asks Mail.

**Annotations say which side a verb reaches.** `openWorldHint: false` means the
folder only. A world verb sets `idempotentHint: true`, and `readOnlyHint: false`
unless it only reads.

## Consequences

- Mail's built actions include `search`, `show`, `label`, and `reconcile`.
  Saved views live under `views/`. A Gmail adapter is still unbuilt (ADR-0873).
- The `@<file>` batch syntax is proposed, not part of the CLI yet.
- Repeating a reconciliation may resend a label assertion, which changes no
  result; an uncertain Messages send must not be repeated.
- Undoing a world change depends on the world: Gmail restores an archived
  message and keeps a trashed one for 30 days. The folder's history does not
  record it.
- A verb that is not safe to repeat costs its author a record of what it did.

## Considered alternatives

- **Three kinds of change: owned, derived, and the world.** Owned and derived
  differ by path, which ADR-0858 already decides, so the action carried a
  distinction it never acts on.
- **Plan, review, and apply as the only way to change the world.** One message
  took three steps, and `apply` duplicated the verbs it ran.
- **Recording each effect in the folder as it happens.** Needed only when a verb
  cannot be repeated; for idempotent verbs, rerunning is the record.
