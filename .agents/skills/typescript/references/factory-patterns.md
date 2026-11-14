# Factory Patterns

## When to Read This
Read this when designing or refactoring factory functions and closure-managed state.

## Inject dependencies once through a named object

Dependencies describe what a capability works with; operation inputs describe
what a particular call asks it to do. Pass dependencies through a destructured
object, even when there is only one. Group related operations in a factory
whose returned methods close over those dependencies.

```typescript
// Avoid positional dependency injection and repeated dependency passing.
const mailbox = createMailbox(db);
await searchMessages(db, { text: 'hello' });
await getMessage(db, { id: 'message-1' });

// Prefer named dependencies supplied once, then operation inputs per call.
const mailbox = createMailbox({ db });
await mailbox.search({ text: 'hello' });
await mailbox.get({ id: 'message-1' });
```

Put the implementation directly in the returned methods. In this illustrative
example, `Database` is the database's owning type, imported from its module:

```typescript
export function createMailbox({ db }: { db: Database }) {
  return {
    search({ text }: { text: string }) {
      return db.query({
        sql: 'SELECT * FROM messages WHERE body LIKE ?',
        params: [`%${text}%`],
      });
    },
    get({ id }: { id: string }) {
      return db.query({
        sql: 'SELECT * FROM messages WHERE id = ?',
        params: [id],
      });
    },
  };
}
```

Avoid a factory whose methods merely forward to standalone helpers such as
`searchMessages({ db }, input)`. The factory already has `db`; its methods can
use it directly. Extract helpers when they own independently useful behavior
or meaningful shared logic, rather than to move a method's body elsewhere.
Pure functions transforming domain data can remain standalone. When a
standalone dependency-taking function is warranted, put its destructured
dependency object first and keep operation input separate.

This convention also applies to function-valued dependencies:
`createSession({ signOut })`, rather than `createSession(signOut)`. It does not
require replacing a useful capability function with an entire service object.

# Parameter Destructuring for Factory Functions

## Prefer Parameter Destructuring Over Body Destructuring

When writing factory functions that take options objects, destructure directly in the function signature instead of in the function body. This is the established pattern in the codebase.

### Bad Pattern (Body Destructuring)

```typescript
// DON'T: Extra line of ceremony
function createSomething(opts: { foo: string; bar?: number }) {
	const { foo, bar = 10 } = opts; // Unnecessary extra line
	return { foo, bar };
}
```

### Good Pattern (Parameter Destructuring)

```typescript
// DO: Destructure directly in parameters
function createSomething({ foo, bar = 10 }: { foo: string; bar?: number }) {
	return { foo, bar };
}
```

### Why This Matters

1. **Fewer lines**: Removes the extra destructuring statement
2. **Defaults at API boundary**: Users see defaults in the signature, not hidden in the body
3. **Works with `const` generics**: TypeScript literal inference works correctly:
   ```typescript
   function select<const TOptions extends readonly string[]>({
     options,
     nullable = false,
   }: {
     options: TOptions;
     nullable?: boolean;
   }) { ... }
   ```
4. **Closures work identically**: Inner functions capture the same variables either way

### When Body Destructuring is Valid

- Need to distinguish "property missing" vs "property is `undefined`" (`'key' in opts`)
- Complex normalization/validation of the options object
- Need to pass the entire `opts` object to other functions

### Codebase Examples

```typescript
// From packages/epicenter/src/core/schema/columns.ts
export function select<const TOptions extends readonly [string, ...string[]]>({
  options,
  nullable = false,
  default: defaultValue,
}: {
  options: TOptions;
  nullable?: boolean;
  default?: TOptions[number];
}): SelectColumnSchema<TOptions, boolean> {
  return { type: 'select', nullable, options, default: defaultValue };
}

// From programs/whispering/.../create-key-recorder.svelte.ts
export function createKeyRecorder({
  pressedKeys,
  onRegister,
  onClear,
}: {
  pressedKeys: PressedKeys;
  onRegister: (keyCombination: KeyboardEventSupportedKey[]) => void;
  onClear: () => void;
}) { ... }
```

# Extract Coupled `let` State Into Sub-Factories

When a factory function accumulates `let` statements that are always read, written, and reset together, extract them into a sub-factory. The tell: two or three `let` declarations that move as a pack across multiple inner functions.

## The Smell

```typescript
function createProvider(config) {
  let retries = 0;
  let reconnectSleeper: Sleeper | null = null;

  async function runLoop() {
    // ... 5-line backoff ceremony using retries + reconnectSleeper ...
    // ... appears in TWO places ...
  }

  function handleOnline() {
    reconnectSleeper?.wake(); // reaches into closure state
  }

  function handleSuccess() {
    retries = 0; // reset scattered across the function
  }
}
```

`retries` and `reconnectSleeper` are one concept ("backoff") split across two `let` declarations, two inline ceremonies, and one external poke.

## The Fix

Pull coupled state into its own factory with named methods:

```typescript
function createBackoff() {
  let retries = 0;
  let sleeper: { promise: Promise<void>; wake(): void } | null = null;

  return {
    async sleep() { /* compute delay, create sleeper, await, cleanup */ },
    wake() { sleeper?.wake(); },
    reset() { retries = 0; },
  };
}
```

The parent factory replaces scattered `let` manipulation with named calls:

```typescript
function createProvider(config) {
  const backoff = createBackoff();

  async function runLoop() {
    await backoff.sleep();     // was 5 duplicated lines
  }

  function handleOnline() {
    backoff.wake();            // was reconnectSleeper?.wake()
  }

  function handleSuccess() {
    backoff.reset();           // was retries = 0
  }
}
```

## When to Extract

| Signal | Action |
|---|---|
| Two+ `let`s always set in the same function | Likely one concept |
| Resetting one requires resetting the others | Definitely one concept |
| An external caller reaches into one of them | The concept needs a public API |
| The same multi-line ceremony appears twice | Extract and name it |

## When NOT to Extract

Don't extract `let` state that's deeply woven into control flow branching. If the variables are the loop's decision-making state (e.g., `desired`, `runId`, `connectRun` in a supervisor loop), extracting them just renames the complexity without reducing it. The test: do the call sites get simpler?

See `docs/articles/let-packs-are-factories-waiting-to-be-named.md` for a full walkthrough with three extractions from a real sync provider.
