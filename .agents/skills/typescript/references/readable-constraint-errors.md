# Readable constraint errors

Suppose an action registry accepts keys such as `tabs_close`, but not
`tabs.close`. The author should see the bad key and the required shape in the
TypeScript error, at the property they need to fix:

```ts
defineActions({
  tabs_close: action,
  'tabs.close': action, // Type 'Action' is not assignable to type
                        // 'Invalid action key "tabs.close": use snake_case ASCII'.
});
```

The helper can make that happen by giving an invalid property's value a
message-shaped type. TypeScript then prints the message as the type it expected:

```ts
type Lower =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

type IsTail<S extends string> = S extends ''
  ? true
  : S extends `${Lower | Digit | '_'}${infer Rest}`
    ? IsTail<Rest>
    : false;
type IsSnakeCase<S extends string> = S extends `${Lower}${infer Rest}`
  ? IsTail<Rest>
  : false;
type InvalidKey<S extends string> =
  `Invalid action key "${S}": use snake_case ASCII`;

function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: IsSnakeCase<K> extends true
      ? T[K]
      : InvalidKey<K>;
  },
): T {
  for (const key of Object.keys(actions)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid action key "${key}"`);
    }
  }
  return actions as T;
}
```

`Action` stands for the registry's actual value type. `IsSnakeCase` checks each
literal key; the mapped parameter keeps its original value type for a valid
key and asks for `InvalidKey<K>` at a bad one. Using `never` would reject the
same property, but its error would only say `not assignable to type 'never'`.
An object-shaped error type tends to complain about a missing property instead
of explaining the bad key. This works because an `Action` cannot be the message
string. For string-valued registries, choose a rejected type that their values
cannot satisfy.

The type check helps while writing a literal object. The runtime check still
matters for JavaScript callers and values forced through with a cast. Keep the
predicate and regex together and make them describe the same rule. For example,
a runtime length limit also needs a type-level length limit if the compiler is
to approve exactly what runtime accepts.

## Things to check when adapting it

- Test a valid literal, an invalid literal, and a widened input. With this
  signature, `Record<string, Action>` is rejected because
  `IsSnakeCase<string>` is false. Accepting dynamic maps requires a separate
  API decision and runtime validation.
- Check the predicate, not whether the resulting message extends `string`.
  `InvalidKey<K>` is itself a string subtype, so
  `InvalidKey<K> extends string ? T[K] : InvalidKey<K>` accepts every key.
- To test runtime rejection in TypeScript, bypass the authoring check on
  purpose: `defineActions({ 'tabs.close': action } as unknown as
  Parameters<typeof defineActions>[0])`. The call should throw.
- Keep diagnostic text easy to read in editor tooltips and CI logs. A plain
  template-literal message works here. Installed `@ark/util` adds U+200B to its
  `ErrorMessage` type, but the suffix is not required for this error and does
  not make a string type nominal. Add it only for a demonstrated completion or
  assignability problem.
- Check library inference before replacing the predicate with a regex-derived
  type. Installed `arkregex` 0.0.5 widens a nondigit range such as `[a-z]` to
  `string`, so it cannot prove this key shape at compile time. Its `.test()`
  returns a boolean; it does not throw for a nonmatch.

The [background article](../../../../docs/articles/20260513T235515-type-level-error-messages.md)
develops the example. The original `defineActions` implementation it discusses
is no longer in the checkout.
