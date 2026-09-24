# Composition diagnostics

Investigate the reported friction: an irrelevant skill loads, two instructions
conflict, references break, or several files repeat the same judgment. Read the
involved instructions together before deciding whether to narrow, merge, move,
or delete them. Shared vocabulary and multiple skills contributing to a task
can be useful; neither requires a taxonomy or a unique owner for every phrase.

## Links and anchors

From the repository root:

```bash
bun run .agents/skills/agent-instructions/scripts/audit-skill-links.ts --root .agents/skills/<skill-name>
```

The scanner checks Markdown links and heading anchors, excluding fenced and
inline code. Omit `--root` for a library-wide check when the change warrants it.
Exit 1 reports findings; `--json` produces structured output. Renames also need a
search for incoming references and a check of the associated Claude symlink.

## Description overlap

For a phrase involved in an actual selection problem:

```bash
bun run .agents/skills/agent-instructions/scripts/audit-routing-collisions.ts --explain "trigger phrase"
```

Stdout lists `phrase -> skill/SKILL.md` matches, annotated as `[claims]` or
`[disclaims]`. Always-on instruction hits appear on stderr. Exit 0 means exactly
one lexical claimant, 1 means zero or several, and 2 means a usage error.

This is substring matching with disclaimer heuristics, not model selection.
A nonzero result asks for inspection, not automatic rewriting: legitimate
composition can produce several matches, and intent can select a skill without
any literal match. Use [evaluation](evaluation.md) when actual selection needs
investigation.

## Repeated guidance

Search the involved files for the repeated idea and read each occurrence in
context. Keep the judgment with its owner and link from a caller that needs it.
A repeated heading alone does not establish duplication, and one caller alone
does not make a useful user-facing capability redundant.

Explain what the proposed deletion changes for a real request. If the user must
now remember an extra step or the agent must reconstruct a local convention,
count that cost before calling the result simpler. Stop when the reported
problem is resolved; a standing audit loop is not part of ordinary maintenance.
