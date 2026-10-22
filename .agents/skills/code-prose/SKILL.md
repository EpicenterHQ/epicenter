---
name: code-prose
description: Apply Orwell's rules to the prose inside code — identifiers and comments — without changing behavior. Use when names, word choice, or comments need an editorial pass.
---
Review changes in the current branch, or in the scope the user specifies. Apply these criteria without changing behavior. Only touch code in that scope, and run the relevant existing checks after changes.

## Word choice in code and comments

Variable names, function names, and comments are all prose. Apply Orwell's rules ("Politics and the English Language") to each:

> Never use a long word where a short one will do.
> 
> If it is possible to cut a word out, always cut it out.
> 
> Never use the passive where you can use the active.
> 
> Never use a foreign phrase, a scientific word, or a jargon word if you can think of an everyday English equivalent.

Latinate vocabulary (reconcile, coalesce, normalize, reconciliation) sounds technical and abstract; Anglo-Saxon words (prune, run, watch, stop, drop, walk) are short and physical. Prefer the Saxon word.

### Names

1. **One word per concept, one concept per word.** Keep a vocabulary. If `sync` names "pulling remote changes," it cannot also name "flushing edits to disk;" rename one of them.
2. **Cut words the context already carries.** A module named `workspaceWatcher` does not need `startNativeWorkspaceWatcher`; `watchWorkspace` says the same thing.
3. **A compound name is usually a hedge:**

- ❌ `lastObservedDiskContent` is a specification to defend
- ✅ `baseline` is a readable description

### Comments

State, in plain English, the constraint the code cannot show: why the **non-obvious** exists.

- ✅ If code is complex and the implementation is non-obvious, add a comment.
- ✅ If a function contains complex behaviors or side effects, add a doc comment.
- 🗑️ If a comment narrates change history from the conversation, delete it.
- 🗑️ If a comment restates code whose behavior is self-evident, delete it.

## Overfitting

Code must stand on its own. If a name or comment only makes sense to someone who watched it happen (this conversation, this PR), it is overfitted. Write for the reader who arrives with no history: rewrite it against the codebase's own vocabulary.

For the structural half of the same discipline — file shape, derivable state, and compatibility with code that never shipped — use [refactoring methods](../collapse-pass/references/refactoring-methods.md).
