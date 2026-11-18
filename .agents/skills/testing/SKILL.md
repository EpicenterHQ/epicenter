---
name: testing
description: Write and challenge tests that catch meaningful mistakes, and improve or delete misleading or unnecessary coverage. Use when writing, reviewing, deleting, or reorganizing tests, especially `*.test.ts` files.
metadata:
  author: epicenter
  version: '3.0'
---

# Testing

Keep tests that help us catch mistakes that matter. Improve or delete tests that give false reassurance or create work without protecting behavior we care about.

## Choose useful tests

Ask what important mistake could happen, whether the test would actually
catch it, and whether the behavior could be protected more simply. Trace the
production path, the setup that makes the failure possible, and the assertion
that detects it. Apply this scrutiny to tests you write as well as existing
ones, including AI-generated tests. Check what a passing result establishes;
test counts and coverage percentages do not establish confidence.

Look for tests, assertions, fixtures, and production seams that add no useful
protection. Combine or delete redundant checks, remove tests for retired
behavior, and repair or replace tests whose setup excludes the failure they
claim to cover. Different inputs, failure mechanisms, dependency boundaries,
and faster diagnosis can justify separate tests. Read unfamiliar tests and
their relevant history before deciding that they have no useful job.

Choose production structure and test boundaries together. When testing
motivates a helper, export, or injected dependency, ask: without the test,
would I have written this as two pieces? Keep boundaries that explain a
responsibility, own a lifecycle, or isolate an external dependency. Test-only
substitution can also earn its place by making important failures reproducible.
Caller counts and line counts are clues, not verdicts.

Before removing a test that detects a required regression, identify what still
catches it. If you can't name where the coverage goes, you haven't earned the
deletion. A test that never detected the claimed failure has no such coverage
to relocate; establish whether the behavior needs a better test. Keep or delete
based on what the test actually contributes, not whether it is currently green
or red. Investigate a failure before changing the expectation or removing it.

Read [the worked examples](references/choosing-useful-tests.md) for examples of
misleading coverage, redundant checks, and useful test seams. Use
[the test deletion grill](references/test-deletion-grill.md) when investigating
whether tests, shared setup, or production seams still earn their cost.

## References

Load these on demand based on what you're working on:

- For **worked examples** of misleading coverage, redundant checks, and useful test seams, read [references/choosing-useful-tests.md](references/choosing-useful-tests.md)
- If working with **type tests** (`expectTypeOf`, `@ts-expect-error`, compiler checks, intentional runtime-invalid input), read [references/type-testing.md](references/type-testing.md)
- If working with **test setup architecture** (single-use definitions, `setup()` patterns, composable setup, cleanup hooks, shared schemas), read [references/setup-pattern.md](references/setup-pattern.md)
- If working with **test organization structure** (flat tests, `describe()` boundaries, helper-over-nesting), read [references/test-structure.md](references/test-structure.md)
- If **auditing existing tests** for hedged assertions, pass-through getters, stalled fakes, dead fake surface, or docstrings that contradict the code, read [references/honest-tests.md](references/honest-tests.md)
- If **choosing new coverage or pruning existing tests** that may not earn their keep, read [references/test-deletion-grill.md](references/test-deletion-grill.md)

External reading:

- Kent C. Dodds, ["Avoid Nesting When You're Testing"](https://kentcdodds.com/blog/avoid-nesting-when-youre-testing) : visible setup and fresh mutable state; hooks still serve cleanup and resource lifetimes
- Kent C. Dodds, ["AHA Testing"](https://kentcdodds.com/blog/aha-testing) : avoid hasty abstractions; introduce fixture factories when shared setup earns them
- Kent C. Dodds, [Testing JavaScript](https://testingjavascript.com) : optional course material; see AHA Testing above for fixture-factory guidance
- Matt Pocock, ["How to test your types"](https://www.totaltypescript.com/how-to-test-your-types) : compiler-checked API contracts, equality assertions, and negative cases; use Bun’s `expectTypeOf` import here
- Matt Pocock, [`shoehorn`](https://github.com/total-typescript/shoehorn) : partial fixtures for legacy or third-party interfaces; incomplete fixtures do not prove a complete input contract

> **Related Skills**: See [services-layer](../services-layer/SKILL.md) for the service patterns being tested. See [typescript](../typescript/SKILL.md) for API design, inference, and editor behavior.

## Result Assertions

When a test asserts a wellcrafted `Result`, use `expectOk` and `expectErr`
from `wellcrafted/testing` instead of hand-rolled error checks.

```ts
import { expectErr, expectOk } from 'wellcrafted/testing';

const data = expectOk(await service.doThing());
expect(data.id).toBe('1');

const error = expectErr(await service.doThing({ invalid: true }));
expect(error.name).toBe('InvalidInput');
```

Avoid local helper clones, `expect(error).toBeNull()` success checks, and
`if (error) throw ...` unwrapping when the value is a wellcrafted `Result`.

This rule does not apply to plain response bodies, UI snapshots, or other
objects that merely have an `error` property.

## Tests vs. Benchmarks

Two distinct file extensions, two distinct purposes:

- **`*.test.ts`** : verifies behavior or type contracts. Runtime tests run
  under `bun test` and may use `expect()` or assertion helpers. Compiler-only
  tests such as `*.types.test.ts` need no runtime assertion; include them in
  the package's typecheck. Passing runtime tests do not verify type assertions.
- **`*.bench.ts`** : measures and reports. Prints tables, timings, or
  storage sizes. Runs under `bun bench` only. No assertions required
  (perf thresholds on shared hardware flake; prefer visual trends).

A single file is one or the other, never both. Benchmarks live under
`src/__benchmarks__/` within a package; tests are colocated with the module
they cover. The `bun test` default-discovery glob picks up only `*.test.ts`
and friends, so renaming a report from `.test.ts` → `.bench.ts` is what
excludes it from CI.

## File-Level Doc Comments

Every `.test.ts` file MUST start with a JSDoc block explaining what is being tested and the key behaviors verified. This serves as documentation for the module's contract.

### Structure

```typescript
/**
 * [Module Name] Tests
 *
 * [1-3 sentences explaining what this file tests and why these tests matter.]
 *
 * Key behaviors:
 * - [Behavior 1]
 * - [Behavior 2]
 * - [Behavior 3]
 *
 * See also:
 * - `related-file.test.ts` for [related aspect]
 */
```

### Good Example

```typescript
/**
 * Cell-Level LWW CRDT Sync Tests
 *
 * Verifies cell-level LWW conflict resolution where each field
 * has its own timestamp. Unlike row-level LWW, concurrent edits to
 * DIFFERENT fields merge independently.
 *
 * Key behaviors:
 * - Concurrent edits to SAME field: latest timestamp wins
 * - Concurrent edits to DIFFERENT fields: BOTH preserved (merge)
 * - Delete removes all cells for a row
 */
```

### Bad Example (Too Minimal)

```typescript
// Tests for create-tables
```

### Section Headers

For long test files (100+ lines), use comment headers to separate logical sections:

```typescript
// ============================================================================
// MESSAGE_SYNC Tests
// ============================================================================
```

## Multi-Aspect Test File Splitting

When a module has distinct behavioral aspects, split into focused test files rather than one monolithic file:

| Pattern                       | Use Case                                             |
| ----------------------------- | ---------------------------------------------------- |
| `{module}.test.ts`            | Core CRUD behavior, happy paths, edge cases          |
| `{module}.types.test.ts`      | Type inference verification, negative type tests     |
| `{module}.{scenario}.test.ts` | Specific scenarios (CRDT sync, offline, integration) |

### When to Split

- File exceeds ~500 lines
- Tests cover genuinely distinct concerns (CRUD vs sync vs types)
- Different setup requirements per concern

### When NOT to Split

- Splitting would create files with fewer than 3 tests
- All tests share the same setup and concern

## Test Naming

Test descriptions MUST be behavior assertions, not vague descriptions. The name should tell you what broke when the test fails.

### Rules

1. **State what happens**, not "should work" or "handles correctly"
2. **Include the condition** when testing edge cases
3. **No filler words**: "should", "correctly", "properly" add nothing

### Good Names

```typescript
test('upsert stores row and get retrieves it', () => { ... });
test('filter returns only published posts', () => { ... });
test('concurrent edits to different fields: both preserved', () => { ... });
test('delete vs update race: update wins (rightmost entry)', () => { ... });
test('observer fires once per transaction, not per operation', () => { ... });
test('get() throws for undefined tables with helpful message', () => { ... });
```

### Bad Names

```typescript
test('should work correctly', () => { ... });         // What works? What's correct?
test('should handle batch operations', () => { ... }); // Handle how?
test('basic test', () => { ... });                     // Says nothing
test('should create and retrieve rows correctly', () => { ... }); // Vague "correctly"
```

### Pattern: `{action} {outcome} [condition]`

```
"upsert stores row and get retrieves it"
 ^^^^^^ ^^^^^^^^^^   ^^^ ^^^^^^^^^^^^^
 action  outcome    action  outcome

"observer fires once per transaction, not per operation"
 ^^^^^^^^ ^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 subject   outcome              condition

"get() returns not_found for non-existent rows"
 ^^^^^ ^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^
 action     outcome            condition
```
