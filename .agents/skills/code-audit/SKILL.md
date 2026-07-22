---
name: code-audit
description: "Codebase-specific smell catalog with calibrated grep recipes: duck-typing at boundaries, yargs argv re-assertions, value-discarding promise tails, console.* in library code, exhaustive `never` over-broad unions, single-method `Pick` deps, `*Like` boundary shape copies. Use for a periodic audit pass, scoping a cleanup PR, after a major refactor, or reviewing a primitive's consumers. Pairs with refactoring (fix mechanics) and post-implementation-review (second-read hub)."
metadata:
  author: epicenter
  version: '1.0'
---

# Code Audit Patterns

Recurring smell categories worth hunting periodically. Each category has a grep pattern, a real example from the repo (if one exists), and a "why it matters" so you know whether a hit is a real smell or expected.

> **Related skills**: See `post-implementation-review` for the full second-read ritual after implementation. See `refactoring` for the methodology of fixing what you find. See `one-sentence-test` for the cohesion audit that frames whether an abstraction earns its keep.

The categories below were validated against the actual codebase by repeated agent audits. They're not generic style nits: each one signals a specific kind of contract problem in a TypeScript-heavy framework codebase.

## 1. Duck-Typing at System Boundaries

**Pattern**: `(x as { foo?: unknown }).foo` or `as Record<string, unknown>` accesses where the shape isn't statically known.

```bash
grep -rn "as\s*{" packages/cli packages/data --include="*.ts" -B2 -A2
```

**Why it matters**: Each duck-type is a contract gap. The receiver doesn't know what it's getting; the producer doesn't know what's expected. Often justified at literal system boundaries (e.g., parsing user-provided configs, reading from third-party APIs), but unjustified inside the framework's own code.

**Example (justified)**: `packages/cli/src/util/handle-attachments.ts:41-45`: duck-types `sync` and `awareness` because the CLI bundles are user-defined and arbitrary. The 30-line comment block above the helper documents exactly why.

**Example (unjustified)**: `if (entry.handle.whenReady)` was duck-typing `whenReady` until it became a typed optional on `Document`. The diagnostic told us the contract was incomplete; the fix was to declare the field.

**How to triage a hit**: read the ~30 lines above the duck-type. If there's a comment explaining why static typing isn't possible at this boundary, leave it. If there's no explanation and the producer is an internal type, either widen the producer's type to include the field, or consolidate the access into a duck-typing helper that's itself well-documented.

## 2. `argv as Record<string, unknown>` Re-Assertions

**Pattern**: yargs argv re-asserted to a broad shape at every command handler.

```bash
grep -rn "argv\s*as\s*Record<string, unknown>" packages/cli --include="*.ts"
```

**Why it matters**: yargs types `argv` as loosely as it can. Every CLI command handler does `const args = argv as Record<string, unknown>` and then keys into it three or four times. Each access is a type-system escape: `argv.foo as string`, `argv.bar as number`. The type system isn't catching missing flags or typos at the source.

**Why it persists**: yargs's typed builder API is verbose and authors trade off ergonomics for safety. The trade is real, but worth periodically auditing: especially when adding a new flag, check whether the access pattern crosses the threshold where a typed argv extraction helper would pay off.

**Triage**: a single command with two flag accesses isn't worth a typed wrapper. Five flags or three commands sharing the same accessor pattern is. Look for **repeated** key access to the same field across command files; that's the signal to extract.

## 3. Promise-Shape Ceremony (`.then(() => {})`)

**Pattern**: explicit value-discarding tails on promise chains.

```bash
grep -rn "\.then\s*\(\s*(\(\)|=> \{\}|=> undefined)" packages --include="*.ts"
```

**Why it matters**: usually indicates the type at the receiving end is too narrow. Authors write `.then(() => {})` to convert `Promise<T>` into `Promise<void>` because the field accepting the promise is typed `Promise<void>` instead of `Promise<unknown>`. The ceremony adds zero semantic value.

**Recipe**: when you see this pattern, look at where the promise is being assigned. If the consumer awaits-and-discards (typical for readiness/teardown barriers), widen the field type to `Promise<unknown>`. The tail disappears.

**Example fix**: this codebase's readiness fields such as `whenReady`, `whenLoaded`, and `whenConnected` were widened from `Promise<void>` to `Promise<unknown>` exactly to eliminate this ceremony. See spec `specs/20260424T000000-self-gating-attachments.md` for the rationale.

**False positive**: if the `.then(() => result)` returns a *meaningful* transformed value, leave it. The smell is specifically the "discard the value" form.

## 4. Unstructured Logging in Library Code

**Pattern**: `console.log` / `console.error` / `console.warn` outside of CLIs, tests, and benchmarks.

```bash
grep -rn "console\.(log|error|warn)" packages/data packages/sync --include="*.ts" | grep -v test
```

**Why it matters**: library code that calls `console` directly can't be redirected, silenced, or piped to a custom sink (in-memory test introspection, telemetry shipping). Every `console.log` is a hardcoded output decision the consumer can't override.

**The framework's logger**: `wellcrafted/logger` provides `createLogger(name)` plus pluggable sinks (`consoleSink`, `memorySink`, `composeSinks`). Three established injection patterns:

```ts
// Module-scoped (default)
const log = createLogger('module-name');

// Optional parameter (for libraries that may want a caller-supplied logger)
function createX({ log = createLogger('x') }: { log?: Logger } = {}) { ... }

// Config-injected (used in openCollaboration)
const log = config.log ?? createLogger('collaboration');
```

**Triage**: this category is verified periodically: the codebase has historically been clean. Treat any hit as a regression and route through `wellcrafted/logger` before merging. New `console.*` in library code should be refused at PR review unless the call site is explicitly a CLI command, test, or benchmark.

## 5. Exhaustive `never` Checks as Union-Churn Signals

**Pattern**: `const _exhaustive: never = x` after a switch on a discriminated union.

```bash
grep -rn ": never\s*=" packages --include="*.ts" -B10
```

**Why it matters**: each `never` check is a contract promise: "if this union grows a variant, every consumer with this check will break." That's *good*: it's the type system catching missed cases. But if adding a single variant breaks five different switches, the variants are probably overlapping, the union is too broad, or the same logic is being implemented in too many places.

**Example (justified)**: `packages/cli/src/util/emit-peer-errors.ts:89` exhaustively switches over `RpcError` variants. `RpcError` has well-bounded variants (well under five), the switch is the canonical formatter, and other code routes through it rather than re-implementing. Single point of enforcement, healthy use of the pattern.

**Triage**: count call sites on the discriminated type. If 1-2 switches enforce exhaustiveness, fine. 5+ is a smell: consider:

- Moving the switch into a method on the union members themselves (each variant exports its own behavior).
- Splitting the union if some switches only care about a subset of variants.
- Extracting a single canonical handler that other consumers delegate to.

**False positive**: type-narrowing on a result type at a boundary is healthy, even if there are several. Look for the pattern of "every consumer has to know about every variant" as the actual signal.

## 6. Single-Method `Pick` Dependencies

**Pattern**: dependency injection shaped as `Pick<Thing, 'method'>`.

```bash
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
```

**Why it matters**: a single-method pick can keep an old object boundary alive after the caller only needs one operation. The type looks narrow, but the object name still tells readers to think about the whole capability family.

**Triage**: write the one-sentence job of the caller and mentally inline the picked method. Keep the object only when that sentence names the object or the caller coordinates the object's life cycle. If the sentence only names one verb, accept a named capability function in the caller's language and update tests to fake that function. Do not replace `Pick<Thing, 'method'>` with `Thing['method']` unless `Thing` is still the caller's real concept.

**False positive**: `Pick` is fine for data projection, DTO trimming, and multi-field view models. A single non-method field like `Pick<Session['session'], 'expiresAt'>` is not this smell.

## 7. Copied TypeScript Boundary Shapes

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

## 8. Non-Exhaustive Union Folds (`if/else` Where a `switch` Belongs)

**Pattern**: an `if (x.type === '...')` / `else` chain that *folds an entire closed discriminated union* (every branch maps a variant to a different output) with no `satisfies never` pin. The inverse of category 5.

```bash
grep -rn "\.error\.name === '" packages apps --include="*.ts" | grep -v test
```

**Why it matters**: the `else` silently absorbs any variant added later; a `switch` with `default: x satisfies never` makes the producer's new variant break the consumer's build instead.

**Validated**: a sweep of `workspace`/`sync`/`cli`/`api` found four (`run-handler.ts`, `run.ts`, `list.ts`, `materializer.ts`), all fixed. Re-run after adding variants to a wire or IPC error union.

**The pattern itself lives elsewhere**: the rule, the predicate/guard/fold triage, and the before/after are in the `define-errors` skill ("Consuming a Variant Union"). This entry is only the detection recipe: use it to find hits, use that skill to classify them.

## What This Skill Doesn't Catch (Reject from the Hunt)

Tested and rejected as not-actually-smells in this codebase:

- **Dead `kind:` branches**: exhaustiveness via `never` enforces this aggressively. No dead branches survive.
- **Stale file names** (`*-manager.ts`, `*-handler.ts`): none found. Naming matches responsibility.
- **Async wrappers doing no work**: Yjs is sync-friendly; the codebase doesn't fake async.
- **Casual `@ts-expect-error` / `@ts-ignore`**: ~234 of them, but all justified (test doubles, duck-typing at system boundaries with comments).

If a future audit finds patterns consistent with these categories, they should be added here. If a category proves false (zero hits across multiple sweeps), demote it.

## Workflow

When kicking off a review pass:

1. Run the greps against the relevant scope (single package, full monorepo, or recently-changed files).
2. For each hit, read the ±5 lines of context and decide: justified, refactor, or false-positive.
3. Group findings by category and impact before fixing: refactoring scattered hits one-at-a-time loses the pattern.
4. Document the fix in a single PR with the audit log. The pattern matters more than the individual instances.

The goal is **systematic detection**, not ad-hoc cleanup. These patterns repeat; codifying them here means future review passes don't re-derive them.
