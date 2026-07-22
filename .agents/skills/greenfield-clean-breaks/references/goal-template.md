# Goal Template

A `/goal` that invokes this skill should stay short. The skill carries the
compatibility-refusal and clean-break review; the goal carries only what varies
per pass.

## Minimal Template

```txt
/goal Run a greenfield clean-break pass on <target>.

  Load skill: greenfield-clean-breaks.
  Target: <path or concept>
  Compatibility stance: <assume no users | preserve public API | ask before public breaks>
  Stop condition: <proposal only | N approved checkpoints | churn threshold>
  Starting target: <narrowest file, package, or boundary>

  Begin.
```

## Worked Examples

### Proposal-Only Pass

```txt
/goal Run a greenfield clean-break pass on Honeycrisp's browser/session/workspace boundary.

  Load skill: greenfield-clean-breaks.
  Target: apps/honeycrisp/src/lib/workspace/browser.ts, apps/honeycrisp/src/lib/session.ts
  Compatibility stance: assume no users except durable workspace/storage shapes.
  Stop condition: proposal only; report before/after shape and wait for OK before editing.
  Starting target: apps/honeycrisp/src/lib/workspace/browser.ts

  Begin.
```

### Implementation Pass

```txt
/goal Run a greenfield clean-break pass on the tab manager mount boundary.

  Load skill: greenfield-clean-breaks.
  Target: apps/tab-manager/mount.ts and apps/tab-manager/src/lib/workspace
  Compatibility stance: assume no users; preserve only documented durable workspace schema.
  Stop condition: 4 approved checkpoints or when remaining findings need product input.
  Starting target: apps/tab-manager/mount.ts

  Begin.
```

### Broader Boundary Pass

```txt
/goal Run a greenfield clean-break pass on the record replica storage boundary.

  Load skill: greenfield-clean-breaks.
  Target: packages/data replica, document, and blob storage modules
  Compatibility stance: ask before public API, sync wire format, or persisted data shape changes.
  Stop condition: three consecutive inspected files produce no actionable findings.
  Starting target: packages/data/src/store/replica

  Begin.
```

## What Does Not Belong In The Goal

The skill already owns:

- The product-sentence rule
- The ownership pass
- The compatibility contract list
- The greenfield smell catalog
- The clean-break mechanics
- The finding format
- The earned-trigger test

If a future goal needs more ritual than this, update the skill or a reference
file instead of copying the ritual into the goal.
