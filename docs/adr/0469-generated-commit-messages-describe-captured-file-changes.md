# 0469. Generated commit messages describe captured file changes

- **Status:** Proposed
- **Date:** 2026-09-30
- **Implementation:** tree-derived subjects for real browser and native commits in the file-folder demo.
- **Unbuilt:** released application adoption of the generated-message policy.

## Context

An app action requests a whole-folder commit after its files are saved. The
commit can capture several saves, another writer's edits, or a partial external
workflow. The action that requested it does not establish what the commit
contains. Repeating one generic subject makes ordinary Git history hard to scan;
operation-specific subjects require attribution and scope checks.

## Decision

**Generate the subject from the exact candidate tree compared with its chosen
parent tree.** Count changed portable-source leaf paths, without rename detection
or grouping a row and its attachment into one unit. Use this finite rule:

| Captured tree change | Subject |
| --- | --- |
| One added path | `Add notes/meeting.md` |
| One changed existing path | `Update notes/meeting.md` |
| One removed path | `Delete notes/meeting.md` |
| Several changed paths | `Update 4 files` |
| No changed paths | No new commit. |

Escape literal paths so control characters cannot forge message fields. Bound
the subject to 72 characters; an escaped path that would exceed that limit uses
`Update 1 file`. The subject contains no generated timestamp: Git already stores
commit dates. No generated body, title extraction, trigger hint, operation
metadata, or AI summarizer is required. Git's diff supplies detailed paths and
contents.

**Rename has no special automatic subject.** Moving a Markdown row and its
unchanged audio changes four paths: two removed and two added. A commit
containing only those changes uses `Update 4 files`; reference edits or other
writers can increase the count. Git may display inferred movement separately.
The message does not certify attachment ownership, reference repair, or a
completed multi-file operation. A partially captured rename follows the same
path rule.

Compute the subject from immutable trees, not from save events or a later
working-tree scan. If a competing branch update changes the parent, refuse the
stale ref update or rebuild the candidate and its message against the new parent.
No subject justifies a blind forced ref update.

Messages describe committed file changes, never recovery instructions or
isolated app actions. File-save success remains independent of commit success.
Imported subjects cannot authorize writes. Optional user-authored messages,
named versions, and restore provenance need their own contract; no automatic
amend, empty milestone commit, or per-save message parameter is introduced.

## Consequences

- Ordinary one-file history names the path without reading Markdown or knowing
  which app action caused the change.
- Coalesced and concurrent changes use counts. Repeated edits can have identical
  subjects; their Git dates and diffs distinguish them.
- Operation template selection, mutation-hint plumbing, and attribution checks
  disappear from message generation.
- Title edits, soft deletion, and historical restores usually appear as file
  updates. Their semantic intent and restore provenance are not recorded here.
- Foreign commits remain inspectable without conforming to app templates.
- History UI can group checkpoints, but a checkpoint is not a per-action undo
  contract. History rewriting and retention are separate decisions.

## Considered alternatives

- Use `Checkpoint saved changes` everywhere. It is truthful but makes a history
  of ordinary one-note edits unnecessarily difficult to scan.
- Put timestamps in the subject. They repeat Git metadata without identifying
  changed source.
- Name the triggering app operation. It requires proving that the captured scope
  still matches the action after coalescing and concurrent edits.
- Infer semantic renames or group same-stem files. It adds pairing and ownership
  logic for presentation that Git history can provide separately.
- Generate a path-list body. It duplicates the detailed tree diff and adds
  formatting and truncation rules.
