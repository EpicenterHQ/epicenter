# 0453. Vocab batch additions share one review

- **Status:** Accepted
- **Date:** 2026-09-24
- **Amends:** [ADR-0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) (explicit entry sources extend beyond selecting a settled answer)

## Context

Vocab currently saves an exact selection from a settled tutor answer or a single expression typed into the sidebar. A learner starting with an empty Words view may already have several expressions, or may want to choose from a starter list. Saving each expression separately makes both cases laborious. Automatic addition would fill the learner's collection without showing what will be saved.

## Decision

**Multiline paste and built-in starter lists both lead to one review of expressions before the learner adds them to Words.** The paste editor treats each line as one expression. Choosing a starter list supplies its expressions to the same review. No entry is written on opening either source. The review shows the expressions, selects all eligible ones by default, and lets the learner unselect any before confirmation.

```text
lines pasted ---------+
                     +--> trim, skip, review --> confirm --> Personal.entries
starter-list texts ---+
```

The review trims outer whitespace and skips blank lines, repeated exact text within the batch, and text already saved in Personal `entries`. It shows counts for repeated and already-saved expressions. It does not change case, strip punctuation, infer definitions, or parse numbered or glossed text. Confirmation sends each still-selected expression through the same exact-text save rule used for a single entry, rechecking current entries in case another device saved one during review. Each new entry starts with an empty learner-owned note and the New stage.

Starter lists are sources of candidate text, not decks or membership attached to entries. The learner may still add one expression directly or save an exact selection from a tutor answer. Neither the source nor the review result is stored on the entry.

## Consequences

Both batch entrypoints share duplicate handling and confirmation. Reopening a starter list shows which exact expressions are already saved; it does not need an installed-list flag or import history. A large list can add hundreds of New entries at once, so Words needs search and stage filtering, while each conversation keeps a small chosen focus.

The existing save check prevents duplicates visible at confirmation time. It does not promise global uniqueness when two offline devices save the same expression concurrently. The actual starter-list contents can be chosen without changing the review or saved entry shape.

## Considered alternatives

- Save a starter list immediately: adds many entries before the learner can inspect or exclude them.
- Keep separate paste and starter-list confirmation screens: duplicates the same review and save behavior.
- Store list membership or import provenance on entries: adds lasting data to support no agreed learner action.
