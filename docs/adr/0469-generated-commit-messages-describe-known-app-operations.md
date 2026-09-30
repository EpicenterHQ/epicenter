# 0469. Generated commit messages describe known app operations

- **Status:** Proposed
- **Date:** 2026-09-30
- **Unbuilt:** deterministic message templates and versioned operation metadata for file-backed history.

## Context

An app knows whether it is saving source, changing a title, renaming an ID, or
restoring a version before it publishes the files. That intent can explain
history without asking a person to write a commit message. External changes
and imported commits may have no known application intent.

## Decision

**Generate messages from known app actions, while describing the actual
checkpoint scope.** A commit can include other writers' saved changes. Use a
neutral subject such as `Checkpoint saved changes` and describe the trigger in
the body when the diff is not limited to the known action. A specific subject
is appropriate only when the captured changes support it:

| Known action | Example subject |
| --- | --- |
| Source autosave, including a derived title | `Edit note n7` |
| Explicit title change | `Set title of note n7` |
| ID rename with its owned audio | `Rename recording r123 to r456` |
| Recording creation | `Create recording r123` |
| Current recording deletion | `Delete recording r123` |
| Historical restore | `Restore note n7 from 3f2a1c9` |
| External change with unknown intent | `Record external change to notes/n7.md` |

Labels describe intent; they do not select separate publication protocols or
promise one isolated action per commit. If a delayed attempt captures different
current bytes, use a generic checkpoint description instead of replaying the
old message as a claim about those bytes.
Title and body edits share the write mechanism. Restore publishes historical
bytes as a new conditional change. A rename includes its moves and declared
reference edits. Each action prepares the requirements for the same publisher.

Optional structured metadata may describe the trigger, explicit rename lineage,
and restore provenance when those facts remain supported by the captured source.
There is no required attribution ledger or durable record of every missed
commit. Keep only facts the snapshot does not establish.
Titles and document contents are unnecessary in the subject. Encode identifiers
and paths so control characters cannot forge extra message fields.

Messages are descriptions, never recovery instructions. File-save success is
independent of commit success. An imported commit's claimed operation ID cannot
establish completion or authorize writes. Unknown external
changes receive a generic description. Similarity cannot establish an app rename
or the scope of repaired references.

## Consequences

- No AI summarizer or person-written message is required for app saves.
- The same publisher serves several understandable history labels.
- Foreign commits remain inspectable without conforming to app templates.
- History UI can group checkpoints, but a checkpoint is not a per-action undo
  contract. History rewriting and retention are separate decisions.

## Considered alternatives

- Parse subjects to recover operations. Wording changes and foreign messages
  would become write authority.
- Infer every operation from a diff. Delete/add does not establish rename
  intent, attachment ownership, or reference-repair scope.
- Create a recovery engine for each label. It repeats publication machinery
  without removing the domain checks.
