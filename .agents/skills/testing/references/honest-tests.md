# Honest Tests

## When to Read This

Read before auditing a test file you suspect is padded, before reviewing
green tests that "feel" hollow, or whenever you add a fake/mock/stub.

If the job is to delete low-value tests across a file or package, read
[test-deletion-grill.md](test-deletion-grill.md) first. It defines the
challenge, response, and resolution workflow and its coverage safeguards.

A green test is not proof of value. A useful test detects a plausible
production regression. Fake behavior must support an exercised scenario;
interface-required members can remain without implying behavioral coverage.

## The Two Questions

Ask both of these for each test in scope. If an answer reveals no meaningful
protection, improve, combine, or delete the test.

```
1. What would have to break in production for this test to fail?
2. Can that thing actually break given how this test constructs the world?
```

Question 2 catches the most failures. Many tests assert behavior that
the test's own setup makes structurally impossible to reach.

## Smells

The collaboration and Y.Doc examples below come from a historical folder-sync test audit. They show how to check what a fixture can exercise and what an assertion can actually detect.

### 1. The hedged assertion that excludes the failure mode

```typescript
// SMELL: alternatives are pre-excluded by the setup
test('initial status is offline or connecting', () => {
  const { collaboration } = setup();           // supervisor parks in CONNECTING sync
  expect(['offline', 'connecting']).toContain(collaboration.status.phase);
});
```

Inside `setup()`, the supervisor reaches `connecting` synchronously
before the call returns. `connected` and `failed` require a handshake
that the fake never delivers. The remaining options are both green. The assertion permits either state without checking which transition
happened, so a wrong initial state can still pass. Delete it or rewrite it to
pin the required state and its cause.

### 2. The pass-through getter

```typescript
// SMELL: asserting that an object literal assigns its own property
test('exposes the supplied installationId', () => {
  const { collaboration } = setup({ installationId: 'self' });
  expect(collaboration.installationId).toBe('self');
});
```

`openCollaboration` does `installationId: config.installationId`. A check
can earn its place when it detects a plausible change that breaks a field
contract callers depend on. Trace the production value and what the assertion
would catch. The check may fit a richer scenario that exercises that contract.

### 3. The fake that stalls past the interesting part

```typescript
function stalledOpenWebSocket(): Promise<WebSocket> {
  const ws = {
    readyState: 0,
    // ... 27 lines of listeners, send, binaryType, addEventListener, etc.
  };
  return Promise.resolve(ws);  // returns a socket that never opens
}
```

A fake that parks in CONNECTING avoids ever simulating `onopen`,
`onmessage`, frame routing, or disconnect. The shape of the fake is the
tell: **whatever the fake refuses to simulate is the behavior the file
isn't testing.** In this case the file shipped under the name
"openCollaboration tests" while testing none of: presence routing,
dispatch result routing, URL query wrapping, or disconnect settling.

### 4. Dead fake surface

If a fake declares `addEventListener`, `removeEventListener`, `send`,
`onmessage`, `onerror`, `binaryType` and so on, every one of those
properties should support an exercised behavior or satisfy a real interface
requirement. Trace the production paths, including teardown. Remove unused
behavior, but keep members whose presence the interface or exercised code
requires. A required member is not evidence that its behavior is covered.

```typescript
// Minimal honest fake for the parked-supervisor case
function fakeWebSocket(): Promise<WebSocket> {
  const ws = {
    readyState: 0,
    onclose: null as ((e: CloseEvent) => void) | null,
    close() {
      if (ws.readyState === 3) return;
      ws.readyState = 3;
      ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);
    },
  };
  return Promise.resolve(ws as unknown as WebSocket);
}
```

Three properties, all reached. If the supervisor later starts using a
fourth, the absent property is a real signal worth investigating, not
noise lost in 27 lines of decoration.

### 5. Docstring contradicting the code

If the file's leading JSDoc says one thing and the body does another,
the doc is worse than missing: it lies to the next reader.

```typescript
// BAD: docstring claim, refuted by the fake's body
/**
 * No real WebSocket: `openWebSocket` returns a never-resolving promise...
 */
function stalledOpenWebSocket(): Promise<WebSocket> {
  // ...
  return Promise.resolve(ws);  // <- promise resolves immediately
}
```

The *socket* stalls in CONNECTING; the *promise* resolves. Fix the doc
to describe what the file actually exercises, and name what it
deliberately doesn't.

### 6. One-line wrappers asserted in isolation

```typescript
// BORDERLINE: dispose() is literally ydoc.destroy()
test('dispose destroys the underlying ydoc', () => {
  const { ydoc, collaboration } = setup();
  let destroyed = 0;
  ydoc.once('destroy', () => destroyed++);
  collaboration[Symbol.dispose]();
  expect(destroyed).toBe(1);
});
```

This check catches a disposal wrapper that stops calling `ydoc.destroy()`.
It earns its place when callers rely on that disposal contract and other
coverage would miss the regression. A documented wrapper alone is not a reason
to add a separate test.

## The audit pass

Read the cases and production paths they exercise. Ask the two questions above
for each case, including setup and teardown. Use the
[test deletion grill](test-deletion-grill.md) to judge meaningful opportunities;
do not write a separate audit record for every test or fake property.

Remove fake behavior and shared setup that surviving cases no longer need.
Re-read the file docstring and test names against what the suite actually
exercises. Repair a real but unreachable scenario rather than treating its
weak setup as permission to lose the required coverage.

## What honest coverage establishes

A test earns its place when its setup can expose a plausible production failure
and its assertions detect that failure. A documented pass-through can still
matter: if disposal stops reaching the underlying resource, the test should
fail for that reason. A test that merely compares fixture values adds no such
protection.

Review setup, assertions, and teardown together. Delete tests and fake behavior
that add no useful protection. Repair meaningful scenarios whose setup prevents
them from exercising the failure. A shorter suite is useful when its retained
checks still catch the mistakes that matter.
