---
name: type-level-error-messages
description: Make compile-time errors readable by branding constraint-violation types as template literal messages with a U+200B zero-width-space suffix. Use when writing helper functions that constrain object keys, string shapes, or other literal-type inputs and you want the TypeScript error tooltip to read as an English sentence pointing at the offending value.
metadata:
  author: epicenter
  version: '1.0'
---

# Type-Level Error Messages

> **Related Skills**: See `typescript` for general TypeScript conventions. See `arktype` for runtime regex validation and where this pattern surfaces in arktype itself.

## The pattern in one example

```ts
// 1. Predicate on the literal type.
type IsSnakeCase<S extends string> = /* recursive template literal walk */;

// 2. Branded error type. The trailing ​ is a zero-width space.
type InvalidKey<S extends string> =
  `Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;

// 3. Helper function. The mapped type returns the value when the key is valid,
//    or the branded error when it isn't. The error is a string but it is not
//    assignable to the value type, so TS surfaces the message at the bad property.
export function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: IsSnakeCase<K> extends true
      ? T[K]
      : InvalidKey<K>;
  },
): T {
  return actions;
}
```

A consumer writing a bad key sees:

```
error TS2322: Type 'Action' is not assignable to type
'Invalid action key "tabs.close", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/'.
```

That reads as an English sentence pointing at the exact problem.

## Why the U+200B suffix

Append `​` (Unicode zero-width space, U+200B) to the error message string. Invisible in IDE tooltips, but it brands the type so it is structurally distinct from any plain string a user could type. Two reasons:

1. **Autocomplete hygiene.** Without the brand, if anywhere in the codebase the inferred type happens to be `Invalid action key "..."`, TypeScript's autocomplete might suggest that literal string as a valid value. The U+200B makes the brand a non-typeable string, so autocomplete stays clean.
2. **Distinct from `S extends string`.** Other type machinery that narrows against arbitrary string subtypes can otherwise accidentally accept the error message. The U+200B prevents accidental matches.

This is exactly what `@ark/util`'s internal `ErrorMessage<message>` does:

```ts
// @ark/util/out/errors.d.ts
export type ErrorMessage<message extends string = string> =
  `${message}${ZeroWidthSpace}`;
```

We replicate it locally rather than reach into `@ark/util` (not part of arktype's public surface).

## Anatomy of a constraint predicate

The recursive template-literal walk is the load-bearing part. For snake_case (`/^[a-z][a-z0-9_]*$/`):

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
```

Adapt the character set for your constraint: kebab-case, slug, semver, hex, etc.

## Why not `arkregex`

`arkregex` parses regex patterns at the type level and infers narrowed template-literal types (e.g. `regex('^ok$', 'i')` infers `'ok' | 'oK' | 'Ok' | 'OK'`). For character classes like `[a-z]`, it intentionally falls back to `string` to avoid combinatorial explosion. Verified empirically:

```ts
import { regex } from 'arkregex';
const snake = regex('^[a-z][a-z0-9_]*$');
//    ^? Regex<string, ...>          <- falls back to string

snake.test('tabs.close');  // compiles fine; runtime would throw
```

For character-class patterns, write the recursive template literal by hand.

## Why not `never` or a string subtype?

| Choice | Tooltip reads |
|---|---|
| `never` | `Type 'X' is not assignable to type 'never'.` (useless) |
| `string` | No error at all (any value is assignable) |
| Branded object: `{ __invalid: S }` | `Property '__invalid' is missing in type 'X' but required in type ...` (reads as missing property, not "bad key") |
| **Branded template literal** | `Type 'X' is not assignable to type 'Invalid action key "tabs.close"...'.` (reads as English) |

The branded template literal wins on readability.

## Why not a `unique symbol` brand?

A `unique symbol` works for nominal types on objects (`type Brand<T, K> = T & { [tag]: K }`), but it does not compose with template literal types. You cannot put a symbol inside `Invalid key "${S}"`. The whole point of this pattern is that the error message IS the brand. Hiding it behind `[tag]: unique symbol` loses the message.

## Where to put the runtime check

Compile-time validation only catches authoring inside the helper's parameter context. Authors can bypass it with:

- `Object.fromEntries(dynamic)`: TS widens key type to `string`, the predicate becomes vacuous.
- `as` cast: explicit bypass.
- Helper called from a `.js` file in a mixed codebase.

So pair the type-level check with a runtime check inside the helper:

```ts
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: IsSnakeCase<K> extends true ? T[K] : InvalidKey<K>;
  },
): T {
  for (const key of Object.keys(actions)) {
    if (!ACTION_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid action key "${key}".`);
    }
  }
  return actions as T;
}
```

Two sources of truth (the template literal type and the regex) for the same rule. The cost is unavoidable: TypeScript cannot derive a runtime value from a type, and `arkregex` does not narrow `[a-z]` to a template literal. Keep both definitions in the same file, close together.

## Common pitfalls

### Mistake 1: checking `Result extends string`

```ts
// WRONG: InvalidKey<S> IS extends string, so this conditional always returns T[K].
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : InvalidKey<S>;
type Param<T> = { [K in keyof T & string]: Validated<K> extends string ? T[K] : Validated<K> };
```

Both branches of `Validated<S>` produce a string type (`S` is a string; `InvalidKey<S>` is a template literal). Check the **predicate** directly:

```ts
type Param<T> = {
  [K in keyof T & string]: IsSnakeCase<K> extends true ? T[K] : InvalidKey<K>;
};
```

### Mistake 2: declaring the helper as `<T extends Record<string, V>>`

If TypeScript picks `T = Record<string, V>` (the widest match), `keyof T = string`. The predicate `IsSnakeCase<string>` evaluates to `false`, so every key gets typed as `InvalidKey<string>`, which rejects everything.

Fix: rely on TS's homomorphic mapped-type inference. The mapped type `{ [K in keyof T & string]: ... }` makes T inferable from the argument's literal keys. Use an explicit `T extends Record<string, V>` constraint (so misuse is caught) but trust the inference for the actual key narrowing.

### Mistake 3: missing the `T = ...` widening case in tests

When you write a test that passes a `Record<string, V>` (e.g. via `as` cast or a dynamic object), the type check at the call site will reject it. Cast through the helper's parameter type to exercise the runtime branch:

```ts
const dynamic = { 'bad.key': v } as unknown as Parameters<typeof defineActions>[0];
expect(() => defineActions(dynamic)).toThrow(/Invalid action key/);
```

### Mistake 4: emoji or em-dash in the error message

The error message is also rendered in CI logs. Keep it ASCII so the message reads everywhere. The U+200B is the only non-ASCII character; it is invisible.

## Reference

- arktype's `ErrorMessage` definition: `node_modules/@ark/util/out/errors.d.ts:25`.
- Background article: `docs/articles/<date>-type-level-error-messages.md`.
