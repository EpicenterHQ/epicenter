---
name: code-audit
description: Find recurring Epicenter code smells and scope the cleanup they require. Use for periodic audits, cleanup PRs, post-refactor reviews, or reviews of a primitive’s consumers.
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
grep -rn "as\s*{" packages apps --include="*.ts" -B2 -A2
```

**Why it matters**: Each duck-type is a contract gap. The receiver doesn't know what it's getting; the producer doesn't know what's expected. Often justified at literal system boundaries (e.g., parsing user-provided configs, reading from third-party APIs), but unjustified inside the framework's own code.

**Example (justified)**: a loader that duck-types fields off a user-authored module it imports at runtime, because the module's shape is arbitrary by design. What makes it justified is the comment block above the access explaining exactly why static typing is impossible there.

**Example (unjustified)**: `if (entry.handle.whenReady)` was duck-typing `whenReady` until it became a typed optional on `Document`. The diagnostic told us the contract was incomplete; the fix was to declare the field.

**How to triage a hit**: read the ~30 lines above the duck-type. If there's a comment explaining why static typing isn't possible at this boundary, leave it. If there's no explanation and the producer is an internal type, either widen the producer's type to include the field, or consolidate the access into a duck-typing helper that's itself well-documented.

## 2. Promise-Shape Ceremony (`.then(() => {})`)

**Pattern**: explicit value-discarding tails on promise chains.

```bash
grep -rn "\.then\s*\(\s*(\(\)|=> \{\}|=> undefined)" packages --include="*.ts"
```

**Why it matters**: usually indicates the type at the receiving end is too narrow. Authors write `.then(() => {})` to convert `Promise<T>` into `Promise<void>` because the field accepting the promise is typed `Promise<void>` instead of `Promise<unknown>`. The ceremony adds zero semantic value.

**Recipe**: when you see this pattern, look at where the promise is being assigned. If the consumer awaits-and-discards (typical for readiness/teardown barriers), widen the field type to `Promise<unknown>`. The tail disappears.

**Example fix**: this codebase's readiness fields such as `whenReady`, `whenLoaded`, and `whenConnected` were widened from `Promise<void>` to `Promise<unknown>` exactly to eliminate this ceremony. See spec `specs/20260424T000000-self-gating-attachments.md` for the rationale.

**False positive**: if the `.then(() => result)` returns a *meaningful* transformed value, leave it. The smell is specifically the "discard the value" form.

## 3. Unstructured Logging in Library Code

**Pattern**: `console.log` / `console.error` / `console.warn` outside of CLIs, tests, and benchmarks.

```bash
grep -rn "console\.(log|error|warn)" packages/workspace packages/sync --include="*.ts" | grep -v test
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

**Two evasions the `console\.` grep misses.** Both import from `wellcrafted/logger` and are therefore invisible to the pattern above, and both were found live in `apps/whispering`:

```bash
grep -rn "consoleSink({" apps packages --include="*.ts" --include="*.svelte"
grep -rn "log\.(warn|error)(new Error" apps packages --include="*.ts" --include="*.svelte"
```

A direct `consoleSink({ ... })` call skips `createLogger`, and with it the `Logger` type that makes `warn`/`error` unary over a `LoggableError`. Whispering's `$lib/report` did this and grew a parallel `log` whose extra `data` argument silently discarded the error object. The only legitimate mention of `consoleSink` is composing it into a sink passed to `createLogger`.

A `new Error(...)` inside a `warn`/`error` call type-checks (native `Error` satisfies `LoggableError` structurally) but hands the sink a message string and no filterable `name`. It usually means the boundary above types its failure callback `(cause: unknown)` and ships no vocabulary, so each implementer invents one. Fix it at the boundary: export the `defineErrors` variants from the file that declares the callback. See the `logging` skill.

## 4. Exhaustive `never` Checks as Union-Churn Signals

**Pattern**: `const _exhaustive: never = x` after a switch on a discriminated union.

```bash
grep -rn ": never\s*=" packages --include="*.ts" -B10
```

**Why it matters**: each `never` check is a contract promise: "if this union grows a variant, every consumer with this check will break." That's *good*: it's the type system catching missed cases. But if adding a single variant breaks five different switches, the variants are probably overlapping, the union is too broad, or the same logic is being implemented in too many places.

**Example (justified)**: one canonical formatter that exhaustively switches over a tagged error union with well under five variants, which every other consumer delegates to rather than re-implementing. Single point of enforcement, healthy use of the pattern.

**Triage**: count call sites on the discriminated type. If 1-2 switches enforce exhaustiveness, fine. 5+ is a smell: consider:

- Moving the switch into a method on the union members themselves (each variant exports its own behavior).
- Splitting the union if some switches only care about a subset of variants.
- Extracting a single canonical handler that other consumers delegate to.

**False positive**: type-narrowing on a result type at a boundary is healthy, even if there are several. Look for the pattern of "every consumer has to know about every variant" as the actual signal.

## 5. Single-Method `Pick` Dependencies

**Pattern**: dependency injection shaped as `Pick<Thing, 'method'>`.

```bash
rg "Pick<[^>]+,\s*['\"][^'\"|]+['\"]\s*>" packages apps
```

**Why it matters**: a single-method pick can keep an old object boundary alive after the caller only needs one operation. The type looks narrow, but the object name still tells readers to think about the whole capability family.

**Example fix**: `packages/workspace/src/daemon/unix-socket.ts` used `Pick<Hono, 'fetch'>` for the socket binder. The binder's job is "bind one request handler to a unix socket and harden the socket file", so the dependency became a `UnixSocketRequestHandler` function instead of a Hono-shaped object.

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

**Validated**: a sweep of `workspace`/`sync`/`cli`/`api` found four (`run-handler.ts`, `run.ts`, `list.ts`, `materializer.ts`), all fixed. Re-run after adding variants to a wire or IPC error union.

**The pattern itself lives elsewhere**: the rule, the predicate/guard/fold triage, and the before/after are in `error-handling`'s [error variants reference](../error-handling/references/error-variants.md). This entry is only the detection recipe: use it to find hits, then read that reference to classify them.

## What This Skill Doesn't Catch (Reject from the Hunt)

Tested and rejected as not-actually-smells in this codebase:

- **Dead `kind:` branches**: exhaustiveness via `never` enforces this aggressively. No dead branches survive.
- **Dead exported types**: many exports across `packages/workspace`; spot-checks always hit consumers. Would need deeper dependency analysis to find real dead ones.
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
