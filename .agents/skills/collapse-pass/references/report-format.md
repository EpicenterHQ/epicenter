# Surface and Report Formats

What to output during a pass and what to deliver at the stop.

## Per-checkpoint surface

After each commit (or each rejected candidate), output one short block in the transcript so the operator can audit without re-reading the diff:

```
Checkpoint N
  Smell: <one of the catalog names>
  Found by: <the rg pattern, verbatim>
  Library citation: <upstream repo and symbol if grounding required, else "n/a">
  Files touched: <comma-separated paths>
  Shortstat: <git diff --shortstat output>
  Tests: <package>: <pass>/<fail>, ...
  Typecheck: <package>: <ok|err>
  Why it collapsed: <one sentence naming the deleted abstraction and what carries the work now>
```

## Final report at stop

Deliver in this exact shape:

### 1. Commits landed

```
<short sha> <conventional-commit subject>
<short sha> <conventional-commit subject>
...
```

Use `git log --oneline <base>..HEAD`.

### 2. One-sentence rationale per commit

For each commit, one line naming the real collapse:

```
<short sha>: <deleted abstraction> collapsed into <where the work now lives>, because <one-sentence reason>.
```

The reason should reference the gate that fired: surface shrank, file count shrank, depth shrank, or first-read got easier.

### 3. Findings deferred

Grouped by package, each with a one-line reason:

```
packages/auth
  - <finding>: requires <product input | external CLI/SDK callers | invariant decision>
packages/app
  - <finding>: requires <...>
```

### 4. Surface delta

```
Exports added:   N
Exports removed: M
Net: -<M - N>
```

Compute by diffing the public exports against `<base>` for every changed `package.json` `exports` field and every top-level `export` in source.

### 5. File count delta

```
Files added:   N
Files removed: M
Net: -<M - N>
```

### 6. Tests run

Per package, the final pass/fail counts:

```
packages/auth:       NN pass, 0 fail
packages/app:      NN pass, 0 fail
...
```

If a test was pre-existing-broken before the pass started, note it once:

```
Pre-existing failures (not introduced by this pass):
  packages/server/src/routes/ai.test.ts: 3 failures (missing provider key)
```

### 7. Rejected smells

End with the rejected list: candidates that the pass considered but did not collapse, with one-line why-not each. This is the audit trail for future passes.

```
Considered but not collapsed:
  - <symbol or pattern>: <one-sentence reason; e.g. "single caller but encodes the workspace-id invariant inline">
  - <symbol or pattern>: <reason>
```
