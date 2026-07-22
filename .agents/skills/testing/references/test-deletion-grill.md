# Test Deletion Grill

## When to Read This

Read this before pruning `*.test.ts` files, auditing a suite for hollow
coverage, or turning a broad "delete bad tests" request into a durable
agent goal.

This reference is for deletion, not assertion repair. If a test is
trying to cover real behavior but is written weakly, rewrite it. If it
cannot name a regression that would become possible after deletion,
delete it.

Related references:

- [honest-tests.md](honest-tests.md) for padded assertions, stalled
  fakes, dead fake surface, and docstrings that lie.
- [cohesion-over-testability](../../cohesion-over-testability/SKILL.md)
  for production code split only so a unit test can reach the inner
  piece.

## Contents

- The grill question
- Deletion taxonomy
- What to do per file
- Punch list format
- What stays
- Commit discipline
- Final report
- Reusable goal

## The Grill Question

For each `test(...)` or `it(...)`, ask:

```txt
If I delete this test, what regression becomes possible that was not
already possible?
```

If the answer is nothing, mark the test for deletion.

Do not delete a test because it is failing. A failing test is either a
bug, a stale spec, or a contract decision. This grill only judges
whether the test earns its keep.

## Deletion Taxonomy

Use these labels in notes, punch lists, commit messages, and final
reports.

### TAUTOLOGY

The test asserts the same value the production code just returned with
no transformation.

```typescript
expect(fn()).toBe(fn());
expect(result.id).toBe(result.id);
```

### IDENTITY OF A LITERAL

The test asserts that a constant equals itself, or that a freshly
constructed object has the fields it was just constructed with.

```typescript
expect({ a: 1 }).toEqual({ a: 1 });
```

### TYPECHECK IN DISGUISE

The assertion would fail to type-check before it could fail at runtime,
so the runtime check earns nothing over the compiler.

```typescript
const value: string = getTypedString();
expect(typeof value).toBe('string');
```

This does not apply to runtime validation at an untyped boundary:
JSON, storage, URL params, worker messages, WebSocket payloads, CLI
argv, or any other data that arrives as `unknown` or `string`.

### MOCK ECHO

Every external dependency is mocked, and the assertion confirms the
mock returned what the mock was told to return. No real behavior is
under test.

```typescript
const client = { fetch: mock(() => 'ok') };
expect(run(client)).toBe('ok');
```

Keep the test only if the behavior under test is the orchestration:
retry policy, fallback choice, cancellation, ordering, error mapping,
or another branch that would break with the same mock response.

### EXIST ONLY TO PROVE EXPORT

The test name is a variant of "method exists", "exports X", or "is a
function", with no behavioral assertion beyond "the import did not
throw".

```typescript
expect(typeof createThing).toBe('function');
```

If importing the module is the contract, put that coverage in a package
smoke test or build check. Do not keep one file per exported symbol.

### STRUCTURE-COUPLED

The test asserts on internal field names, private call ordering, helper
boundaries, or harness details that no consumer would observe. A
refactor would update the test in lockstep with production code, but no
real regression would be caught.

Stale harnesses usually fall here. If production stopped using
`XDG_RUNTIME_DIR`, tmpdir bootstrapping, or another old setup path, a
test that still proves only that path is no longer protecting the
product.

### REDUNDANT WITH A CALLER

The same behavior is already covered by an integration test or caller
test that exercises the path through a real boundary. The unit test
adds no confidence the caller test does not already provide.

Keep the unit test only when it isolates a smaller invariant that the
caller test cannot diagnose clearly, or when the caller test is too
slow or flaky to be the sole signal.

### COHESION-OVER-TESTABILITY SPLIT

The production function was split into a "pure" inner and a thin wrapper
only so this unit test could reach the inner piece. Delete the split,
fold the logic back, and cover through the wrapper's existing test or an
integration test.

When you see this, read
[cohesion-over-testability](../../cohesion-over-testability/SKILL.md)
before editing production code.

## What to Do Per File

1. Read the file front to back. List every `test(...)` and `it(...)`.
2. For each test, answer the grill question in one sentence.
3. Mark any deletion candidate with one taxonomy label.
4. If the whole file fails the grill, delete the file and remove unique
   fixtures it owned.
5. If individual tests fail the grill, delete just those tests. Keep the
   `describe` block only if real tests remain.
6. After deletion, run the package's test suite.
7. If a real test breaks because shared setup was deleted, restore the
   setup and keep the deletion.

If any package has more than about 10 candidates, show the punch list
before deleting. For small packages, do the work directly.

## Punch List Format

When you need to show candidates before editing, use this shape:

```txt
| File | Test | Category | Why deletion is safe | Remaining coverage |
| ---- | ---- | -------- | -------------------- | ------------------ |
```

Keep each row concrete. "Looks redundant" is not enough. Name the
caller test, integration test, type check, or contract boundary that
makes the deletion safe. If there is no replacement coverage and the
behavior is still real, rewrite the test instead of deleting it.

## What Stays

Some tests look tautological because they pin a contract outside the
type system. Keep these unless the user explicitly accepts the contract
change.

- Wire formats: HKDF labels, durable identifier strings, URL shapes,
  sync payload names, persisted blob layouts.
- Error variant names or status codes that cross a process, network,
  worker, CLI, storage, or package boundary.
- Runtime validation for unknown input, even when the validated shape
  mirrors a TypeScript type.
- Invariants the type system cannot express: single-flight,
  idempotency, ordered shutdown, disposal ordering, race resolution,
  retries, cancellation, and resource cleanup.
- Regression tests for bugs that were subtle enough to recur, even if
  the final assertion is small.

## Commit Discipline

Use one commit per package or per test file. Do not make one giant
deletion commit unless the user asked for it.

Commit messages should list:

- Deleted test names.
- Grill category for each deletion.
- Caller or integration test that still covers the behavior, when one
  exists.

Example body:

```txt
Deleted:
- "exports createWorkspace" (EXIST ONLY TO PROVE EXPORT)
- "returns the mocked user" (MOCK ECHO)

Remaining coverage:
- packages/data/src/lens.test.ts covers
  Lens definition validation through the public record API.
```

## Final Report

End with one table:

```txt
| File | Tests deleted | Tests kept | Deletion categories |
| ---- | ------------- | ---------- | ------------------- |
```

Also report the total line count delta. The win is fewer lines, a
faster suite, and a sharper signal when something breaks.

## Reusable Goal

Use this shape for a long-running pruning pass:

```txt
/goal Prune `*.test.ts` files in [scope] until every remaining test either fails for a real regression or pins a contract that cannot be expressed in types. First read `.agents/skills/testing/SKILL.md` and `.agents/skills/testing/references/test-deletion-grill.md`. Work package by package. For each deletion, record the test name and grill category, run the package test suite, and surface the result. Show a punch list before deleting if any package has more than about 10 candidates. Pause before deleting failing tests, wire-format tests, persisted-contract tests, or tests whose coverage replacement is unclear.
```
