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

> **Related Skills**: See [typescript](../typescript/SKILL.md) for API design, inference, and editor behavior.

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
  storage sizes. Run it directly with `bun <file>`; no root script runs benchmarks. No assertions required
  (perf thresholds on shared hardware flake; prefer visual trends).

A single file is one or the other, never both. Benchmarks live under
`src/__benchmarks__/` within a package; tests are colocated with the module
they cover. The `bun test` default-discovery glob picks up only `*.test.ts`
and friends, so renaming a report from `.test.ts` → `.bench.ts` is what
excludes it from CI.

## Organize tests

Name each test for the behavior it protects. Include the condition when it
changes the outcome, as in `a dry run makes no provider calls`. Add a comment
when a fixture or constraint needs an explanation.

Keep tests together when they protect the same behavior and share setup.
Split them when different behavior or setup makes each file easier to read.
