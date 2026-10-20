# Recorded Runs

Live runs of `scripts/run-trigger-eval.ts`, kept so the claims in
`references/evaluation.md` can be checked rather than taken on trust.

`routing-baseline.json` is the shipped corpus with a repository `AGENTS.md` in
place: 11 measurable cases, 3 runs each, all clean. It is the reference point
for a description edit.

The four `always-on-gate-*` files are the result records from one A/B/C/D over
`evals/always-on-gate.json`, 5 runs per case except the control. The original
arms reportedly differed only in `AGENTS.md`:

```txt
armA-present           the repository's Review gates paragraph, unmodified
armB-absent            that paragraph deleted, everything else byte-identical
armC-override-control  a blatant routing sentence, to prove the probe can see AGENTS.md at all
armD-narrowed          the paragraph shortened to its orphaned intents
```

The result records retain instruction digests, not complete arm snapshots,
commands, tool versions, timestamps, or commits. They therefore cannot
independently establish that claim or reproduce its rates. They remain useful
as the experiment that motivated the corpus and stale-run check; rerun it in
isolated worktrees for current evidence. Arm C is a fixture, never a proposal.
Arm D was not adopted; `references/evaluation.md` explains what it cost.

## Check Before Quoting A Number

A stored rate is a fact about the `AGENTS.md` that produced it and about no
other one, which is the finding these runs exist to support. So ask the tree
rather than the file:

```bash
bun run skills-and-instructions/scripts/run-trigger-eval.ts --verify-runs skills-and-instructions/evals/runs
```

```txt
comparable   the run's instructions match this tree; its rates still describe it
superseded   AGENTS.md or CLAUDE.md has changed since; re-run before quoting a rate
undigested   recorded before the digest existed; it cannot say what produced it
```

No file here is `comparable` against the commit that added it. The four arms
were measured on a branch whose `AGENTS.md` carried two paragraphs this one does
not, and `routing-baseline.json` predates the digest entirely. The historical
contrast motivated the current corpus, but its stored logs alone cannot
establish that both arms shared the same surrounding text. No absolute rate
remains current or independently auditable from these files.

## Reproduce

Check the same commit out into two worktrees, edit `AGENTS.md` in one, and run
the corpus in each. A probe re-reads `AGENTS.md` from disk at spawn, so editing
it under a running eval silently mixes the arms. Keep both worktrees outside the
repository: nested inside it, the agent loads the parent checkout's `CLAUDE.md`
as well, which confounds the arms with a file no arm meant to vary.
