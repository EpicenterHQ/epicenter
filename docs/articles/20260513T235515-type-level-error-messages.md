# Make TypeScript Errors Read Like English

TypeScript can tell you exactly what's wrong with a value at compile time. Make the expected type for an invalid literal a sentence that names the value. When assignment fails, the error tooltip points at the bad key and says what shape it needs.

Arktype uses message-shaped types internally. Here is the pattern applied to an action registry.

## The problem

You wrote a helper that constrains object keys to a shape, like snake_case for action registry keys, or kebab-case for route slugs:

```ts
function defineActions<T extends Record<string, Action>>(actions: T): T {
  for (const k of Object.keys(actions)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) {
      throw new Error(`Invalid action key "${k}"`);
    }
  }
  return actions;
}
```

That catches the bad key at runtime. But the author wrote `'tabs.close'` an hour ago, the typecheck passed, the bundle shipped, and the daemon crashed at boot. Edit-site feedback would have saved them an hour.

You want this to fail in the IDE, with a message that names the bad key.

## The rejected type decides what the error says

`never` as the rejected type:

```ts
type IsSnakeCase<S extends string> = /* ... */;
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : never;
```

Error tooltip: `Type 'Action' is not assignable to type 'never'`. Useless without context.

Branded object:

```ts
type Invalid<S extends string> = { __invalid: S };
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : Invalid<S>;
```

Error tooltip: `Property '__invalid' is missing in type 'Action' but required in type '{ __invalid: "tabs.close" }'`. Reads as "missing property", not "bad key shape."

Plain template literal error message:

```ts
type Invalid<S extends string> = `Invalid action key "${S}"`;
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : Invalid<S>;
```

This works when the registry's value type, `Action`, cannot be the message string. A string-valued registry needs a different rejected type or another constraint: someone could otherwise supply the exact message as a value.

## Use the message as the expected type

```ts
type InvalidKey<S extends string> =
  `Invalid action key "${S}": use snake_case ASCII`;
```

The message is a string literal type. The failed assignment makes TypeScript print it as the type it expected.

The error tooltip reads as a sentence:

```
Type 'Action' is not assignable to type
'Invalid action key "tabs.close": use snake_case ASCII'.
```

## The full helper

```ts
type Lower =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type WordChar = Lower | Digit | '_';

type IsTail<S extends string> = S extends ''
  ? true
  : S extends `${WordChar}${infer Rest}`
    ? IsTail<Rest>
    : false;

type IsSnakeCase<S extends string> = S extends `${Lower}${infer Rest}`
  ? IsTail<Rest> extends true
    ? true
    : false
  : false;

type InvalidKey<S extends string> =
  `Invalid action key "${S}": use snake_case ASCII`;

export function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: IsSnakeCase<K> extends true ? T[K] : InvalidKey<K>;
  },
): T {
  for (const k of Object.keys(actions)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) {
      throw new Error(`Invalid action key "${k}"`);
    }
  }
  return actions as T;
}
```

Author-site:

```ts
defineActions({
  tabs_close: defineMutation({ /* ... */ }),    // fine
  'tabs.close': defineMutation({ /* ... */ }),  // TS error at this property
  TabsClose: defineMutation({ /* ... */ }),     // TS error
  '0tab': defineMutation({ /* ... */ }),        // TS error
});
```

## The invisible suffix is optional

`@ark/util` appends U+200B to its internal `ErrorMessage` type:

```ts
// node_modules/@ark/util/out/errors.d.ts
export type ErrorMessage<message extends string = string> =
  `${message}${ZeroWidthSpace}`;
```

That changes exact string assignability, but it is still a string subtype. It does not create a nominal brand or make this diagnostic work. Add the suffix only if a concrete completion or assignability problem calls for it; this example needs none. `@ark/util` has a separate `noSuggest` type for completion behavior.

## The pitfall: checking the wrong thing

You might be tempted to write:

```ts
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : InvalidKey<S>;

function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: Validated<K> extends string ? T[K] : Validated<K>;
  },
): T { /* ... */ }
```

Both branches of `Validated<S>` produce a string (`S` is a string; `InvalidKey<S>` is a template literal). So `Validated<K> extends string` is always true, and `T[K]` is always returned. The constraint is dead.

Check the **predicate** directly:

```ts
[K in keyof T & string]: IsSnakeCase<K> extends true ? T[K] : InvalidKey<K>;
```

## Can `arkregex` do this for me?

`arkregex` parses regex strings at the type level and infers template literal types. `regex('^ok$', 'i')` infers as `'ok' | 'oK' | 'Ok' | 'OK'`. Cool.

In the installed 0.0.5 types, a nondigit range like `[a-z]` widens to `string`. This pattern therefore cannot prove our key shape:

```ts
import { regex } from 'arkregex';
const snake = regex('^[a-z][a-z0-9_]*$');
//    ^? Regex<string, ...>          <- not narrowed

snake.test('tabs.close');  // compiles fine, returns false
```

Other regex patterns can retain useful type information. For this character-range constraint, write the recursive template literal by hand.

## Keep the runtime check

The type check catches authoring inside the helper's parameter context. A widened `Record<string, Action>` is rejected by this signature, not silently accepted. Runtime validation still protects calls that bypass the type check:

- `as` casts: explicit bypass
- Helper called from `.js` files in mixed codebases

So pair the type-level check with a runtime check inside the helper. Keep the predicate and regex next to each other and describe the same rule. TypeScript cannot derive the runtime check from the type, so both definitions need to stay aligned.

## When to reach for this

- Constraining object keys (action registries, slug maps, route tables).
- Constraining string-literal arguments (semver, color hex, ISO date strings).
- Anywhere you'd otherwise write `validate()` as a separate call and want it to surface at the edit site instead.

The pattern adds about 15 lines of TypeScript and one runtime regex per constraint. The payoff: bad inputs fail at the property in the IDE, with a message that reads like a sentence. Authors don't need to remember to call a validator. They just type, and the editor tells them what's wrong.
