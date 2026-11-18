---
name: code-audit
description: Find recurring Epicenter code smells and scope the cleanup they require. Use for periodic audits, cleanup PRs, post-refactor reviews, or reviews of a primitive’s consumers.
metadata:
  author: epicenter
  version: '1.0'
---

# Code Audit Patterns

Recurring smell categories worth hunting periodically. Each category has a grep pattern, a real example from the repo (if one exists), and a "why it matters" so you know whether a hit is a real smell or expected.

> **Related skills**: See `post-implementation-review` for the full second-read ritual after implementation. See [refactoring methods](../collapse-pass/references/refactoring-methods.md) for fixing what you find. See `one-sentence-test` for the cohesion audit that frames whether an abstraction earns its keep.

The categories below were validated against the actual codebase by repeated agent audits. They're not generic style nits: each one signals a specific kind of contract problem in a TypeScript-heavy framework codebase.

## 1. Hunt for duck typing

Actively search the audited scope for runtime shape checks, casts to
locally invented object shapes, and property access through
`Record<string, unknown>`. Use the search recipes in
[the duck-typing reference](references/duck-typing.md), then follow relevant
producers and consumers.

For each candidate, establish what the caller needs to know and why
the existing type does not provide it. Look for missing declarations,
copied contracts, repeated capability checks, and casts that assume
more than the code verifies.

Prefer fixing the contract at its owner. Import or derive an existing
type when it already expresses the agreement. For external input,
validate what the consumer needs before relying on it.

Keep runtime checks that recognize a supported capability or validate
input whose shape is not yet known. Verify that the check establishes
what the following code assumes. A comment explains the decision;
it does not establish correctness.

Explain concrete problems, their consequences, and the proposed repair.
A search match alone is not a finding.

## 2. Hunt for unnecessary promise conversions

Actively search the audited scope for empty fulfillment callbacks such
as `.then(() => {})` and `.then(() => undefined)`, including equivalent
callbacks written across several lines. Use
[the promise-shape reference](references/promise-shape.md) for search
recipes and examples.

Trace the original promise, the callback, the receiving declaration,
and the consumers. Establish whether the callback only discards a
value, performs work, or enforces an intentional result contract.

When a consumer only waits for completion and ignores the value,
consider accepting `Promise<unknown>` at that boundary. Remove a
value-discarding adapter when the contract no longer requires it.

Keep deliberate `Promise<void>` contracts when callers should receive
no result. Keep callbacks that perform work or transform results.
Check fulfillment and rejection handling, cleanup, and ordering
before removing a promise-chain step.

Explain the unnecessary conversion and the contract that makes its
removal sound. A `.then(...)` match alone is not a finding.

## 3. Hunt for logging bypasses

Hunt for library diagnostics that bypass `wellcrafted/logger`, including
direct console calls, custom logging wrappers, and direct sink emission.
Use [the logging audit reference](references/logging.md) for search recipes
and a real migration example.

Use [the logging skill](../logging/SKILL.md) to move those diagnostics onto
the shared logger. Preserve the original cause, useful context, and
surrounding behavior. Remove redundant logging machinery once its callers
use the shared path.

Distinguish diagnostics from deliberate application or command output.

## 4. Check switches for missing cases

Find switches that are responsible for every case of a closed union. Give
each case an explicit branch and end with `default: value satisfies never`
so adding a variant fails typechecking until the switch handles it.

Use [the exhaustive-unions reference](references/exhaustive-unions.md) to
find candidate switches and recognize when a runtime fallback is needed.

## 5. Single-Method `Pick` Dependencies

**Pattern**: dependency injection shaped as `Pick<Thing, 'method'>`.

```bash
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
```

**Why it matters**: a single-method pick can keep an old object boundary alive after the caller only needs one operation. The type looks narrow, but the object name still tells readers to think about the whole capability family.

**Historical socket binder.** The folder-sync daemon took a request handler to bind a Unix socket and harden the socket file. A dependency on `Pick<Hono, 'fetch'>` also required the caller to supply an object. The resulting binder took `fetch` directly. See `364f3b5bd2:packages/workspace/src/daemon/unix-socket.ts`.

**Triage**: write the one-sentence job of the caller and mentally inline the picked method. Keep the object only when that sentence names the object or the caller coordinates the object's life cycle. If the sentence only names one verb, accept a named capability function in the caller's language and update tests to fake that function. Do not replace `Pick<Thing, 'method'>` with `Thing['method']` unless `Thing` is still the caller's real concept.

**False positive**: `Pick` is fine for data projection, DTO trimming, and multi-field view models. A single non-method field like `Pick<Session['session'], 'expiresAt'>` is not this smell.

## 6. Copied TypeScript Boundary Shapes

**Pattern**: local helper types that copy upstream shapes instead of deriving
from the owner.

```bash
rg "type\s+\w+Like\b|interface\s+\w+Like\b" packages apps
rg "as\s+\w+Like\b" packages apps
rg "as\s+Record<string, unknown>" packages apps
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
rg "Parameters<typeof\s+[^>]+>\[[0-9]+\]" packages apps
```

**Why it matters**: copied shapes create two sources of truth. A `Like` type,
single-method `Pick`, or `Parameters<typeof fn>[n]` contortion can look precise,
but often says "this layer knows an upstream object exists and only wants one
piece of it." That is a boundary leak. Either derive from the owning runtime
type, schema, factory, or function signature, or name the one capability the
caller actually needs.

**Triage**: read nearby context before judging. Classify each hit as:

- justified boundary: external input, protocol compatibility, or a real shared
  contract
- test fake only: acceptable when contained in `*.test.ts` or setup helpers
- refactor candidate: internal code copies a local upstream shape or production
  code widened only to satisfy a test seam
- false positive: data projection, DTO trimming, or a named capability that is
  the actual caller-owned contract

**Recipe**: clear candidates usually collapse one of four ways: derive the type
from the owner, replace object-shaped dependency injection with a named
capability function, move incomplete fake objects into tests with `satisfies`,
or delete one-property option aliases that only rename the function signature.

**False positive**: `Parameters<typeof fn>[n]` is fine when it derives a public
helper type from a stable exported function. It becomes a smell when tests use it
to reverse-engineer an unnamed seam, or when the index gymnastics hide the fact
that the caller wants a smaller named capability.

## 7. Non-Exhaustive Union Folds (`if/else` Where a `switch` Belongs)

**Pattern**: an `if (x.type === '...')` / `else` chain that *folds an entire closed discriminated union* (every branch maps a variant to a different output) with no `satisfies never` pin. The inverse of category 4.

```bash
grep -rn "\.error\.name === '" packages apps --include="*.ts" | grep -v test
```

**Why it matters**: the `else` silently absorbs any variant added later; a `switch` with `default: x satisfies never` makes the producer's new variant break the consumer's build instead.

**Historical folder-sync audit.** A sweep of `workspace`/`sync`/`cli`/`api` found four (`run-handler.ts`, `run.ts`, `list.ts`, `materializer.ts`), all fixed. Re-run after adding variants to a wire or IPC error union.

**The pattern itself lives elsewhere**: the rule, the predicate/guard/fold triage, and the before/after are in `error-handling`'s [error variants reference](../error-handling/references/error-variants.md). This entry is only the detection recipe: use it to find hits, then read that reference to classify them.

## What This Skill Doesn't Catch (Reject from the Hunt)

Tested and rejected as not-actually-smells in this codebase:

- **Dead `kind:` branches**: exhaustiveness via `never` enforces this aggressively. No dead branches survive.
- **Stale file names** (`*-manager.ts`, `*-handler.ts`): none found. Naming matches responsibility.
- **Casual `@ts-expect-error` / `@ts-ignore`**: ~234 of them, but all justified (test doubles, duck-typing at system boundaries with comments).

If a future audit finds patterns consistent with these categories, they should be added here. If a category proves false (zero hits across multiple sweeps), demote it.

## Workflow

When kicking off a review pass:

1. Run the greps against the relevant scope (single package, full monorepo, or recently-changed files).
2. For each hit, read the ±5 lines of context and decide: justified, refactor, or false-positive.
3. Group findings by category and impact before fixing: refactoring scattered hits one-at-a-time loses the pattern.
4. Document the fix in a single PR with the audit log. The pattern matters more than the individual instances.

The goal is **systematic detection**, not ad-hoc cleanup. These patterns repeat; codifying them here means future review passes don't re-derive them.
