# Skill evaluation

Start with the uncertainty: was the wrong skill selected, did the right skill
do the wrong work, or is a proposed improvement untested? Use a real request
and inspect what the agent loaded and did. Description, body, always-on
instructions, and host behavior can all matter; change the surface implicated
by the evidence rather than assuming a routing failure has only one cause.

## Compare behavior

For an existing skill, compare with the previous version; for a new capability,
compare with no skill. Include the motivating request, materially different
requests, and plausible near misses. Judge decisions and useful outcomes, not
similarity to an approved example. Use fresh context where possible and record
the relevant instructions, inputs, runtime, and outputs so the comparison can
be understood later. Repeat when variability affects the conclusion.

A mechanically valid skill can still be unhelpful. Report unnecessary work,
missed conventions, or burden transferred to the user. If no meaningful benefit
appears, narrow or remove the guidance instead of accumulating exceptions.

## Existing diagnostic tools

Commands below run from the repository root and require Bun. The offline pass
reads the stored corpus and descriptions:

```bash
bun run .agents/skills/agent-instructions/scripts/run-trigger-eval.ts
```

It checks lexical coverage, not routing. `--case <id>` selects a case;
`--corpus <file>` selects another corpus; `--json` changes output; `--strict` makes
lexical findings fail the command. Those findings still need interpretation.

The opt-in live probe requires an authenticated Claude CLI and consumes quota:

```bash
bun run .agents/skills/agent-instructions/scripts/run-trigger-eval.ts --live --case <id> --runs 3 --budget-ms 120000
```

The probe permits only the Skill tool and asks the model to select a skill and
stop. It measures that restricted Claude decision, not normal task performance
or Codex selection. Codex-routed cases are reported as NOT MEASURED. Use it only
when this proxy answers the question; an actual task comparison may be needed.

`--timeout-ms` bounds each probe. `--budget-ms` stops new cases after the
elapsed budget; repetitions of an already-started case can overrun it.
`--limit` can leave cases unmeasured; timeouts and partial runs are not passing
evidence.
`--model`, `--effort`, and `--out` support recorded comparisons. Consult `--help`
for options.

## Historical records

The default corpus is `evals/routing.json`; `evals/always-on-gate.json` covers an
older always-on routing experiment. The [recorded runs](../evals/runs/README.md)
retain its results but not complete arm snapshots. Narrowing the gate reportedly
weakened other routes, so that arm was not adopted. This motivated diagnostic
work; it does not establish a general routing law or require measuring every
instruction edit. Its rates are not current evidence.

```bash
bun run .agents/skills/agent-instructions/scripts/run-trigger-eval.ts --verify-runs .agents/skills/agent-instructions/evals/runs
```

This compares AGENTS.md and CLAUDE.md fingerprints only. A comparable verdict
does not check whether skill descriptions, bodies, the corpus, model, or runtime
still match. Verify those separately before interpreting an old result.

Keep comparison inputs stable during a run. For worktree comparisons, place
worktrees outside the repository so inherited parent instructions do not
contaminate the comparison. Preserve enough evidence to distinguish a changed
instruction from a changed environment.
