---
name: arktype
description: 'Arktype: runtime validation, discriminated unions with .merge()/.or(), spread keys. Use when mentioning arktype, type(), union types, command/event schemas.'
metadata:
  author: epicenter
  version: '1.0'
---

# Arktype Patterns

Patterns for composing arktype schemas, naming runtime schema values alongside inferred types, and building discriminated unions with `.merge()` and `.or()`.

## `base.merge(type.or(...))` Pattern (Recommended)

Use when you have shared base fields and per-variant payloads discriminated on a literal key. `.merge()` distributes over unions: it merges the base into each branch of the union automatically.

```typescript
import { type } from 'arktype';

const commandBase = type({
	id: 'string',
	deviceId: DeviceId,
	createdAt: 'number',
	_v: '1',
});

const Command = commandBase.merge(
	type.or(
		{
			action: "'closeTabs'",
			tabIds: 'string[]',
			'result?': type({ closedCount: 'number' }).or('undefined'),
		},
		{
			action: "'openTab'",
			url: 'string',
			'windowId?': 'string',
			'result?': type({ tabId: 'string' }).or('undefined'),
		},
		{
			action: "'activateTab'",
			tabId: 'string',
			'result?': type({ activated: 'boolean' }).or('undefined'),
		},
	),
);
```

### How it works

1. `type.or(...)` creates a union of plain object definitions. Each is a variant with its own fields.
2. `commandBase.merge(union)` distributes the merge across each branch of the union. Internally, arktype calls `rNode.distribute()` to apply the merge to each branch individually ([source](https://github.com/arktypeio/arktype/blob/6d0639bf/ark/schema/roots/root.ts#L290-L302)).
3. The result is a union where each branch has all `commandBase` fields plus its variant-specific fields.
4. Arktype auto-detects the `action` key as a discriminant because each branch has a distinct literal value.
5. `switch (cmd.action)` in TypeScript narrows the full union. Payload fields and result types are type-safe per branch.

### Why this pattern

| Property               | Benefit                                            |
| ---------------------- | -------------------------------------------------- |
| Base is a real `Type`  | Reusable, composable, inspectable at runtime       |
| `.merge()` distributes | No need to repeat `base.merge(...)` per variant    |
| `type.or()` is flat    | All variants in one list, easy to read and add to  |
| Base appears once      | DRY: change base fields in one place               |
| Auto-discrimination    | No manual discriminant config needed               |
| Flat payload           | No nested `payload` object; fields are top-level   |

## `.merge().or()` Chaining Pattern (Good for 2-3 variants)

Use when you have a small number of variants where chaining reads naturally.

```typescript
const Command = commandBase
	.merge({
		action: "'closeTabs'",
		tabIds: 'string[]',
		'result?': type({ closedCount: 'number' }).or('undefined'),
	})
	.or(
		commandBase.merge({
			action: "'openTab'",
			url: 'string',
			'result?': type({ tabId: 'string' }).or('undefined'),
		}),
	);
```

For 4+ variants, prefer `base.merge(type.or(...))` to avoid repeating `commandBase.merge(...)` per branch.

## The `"..."` Spread Key Pattern (Alternative)

Use when defining inline without a pre-declared base variable, or when you prefer a more compact syntax.

```typescript
const User = type({ isAdmin: 'false', name: 'string' });

const Admin = type({
	'...': User,
	isAdmin: 'true',
	permissions: 'string[]',
});
```

The `"..."` key spreads all properties from the referenced type into the new object definition. Conflicting keys in the outer object override the spread type (same as `.merge()`).

**Constraint**: The `"..."` key must be the first key in the object. Arktype throws `ParseError: Spread operator may only be used as the first key` otherwise. Prefer `.merge()` when you need more flexibility.

### Spread key in unions

```typescript
const Command = type({
	'...': commandBase,
	action: "'closeTabs'",
	tabIds: 'string[]',
}).or({
	'...': commandBase,
	action: "'openTab'",
	url: 'string',
});
```

Functionally equivalent to `.merge().or()`. Choose based on readability preference.

## `.or()` Chaining vs `type.or()` Static

### Chaining (preferred for 2-3 variants)

```typescript
const Command = variantA.or(variantB).or(variantC);
```

### Static `type.or()` (preferred for 4+ variants)

```typescript
const Command = type.or(variantA, variantB, variantC, variantD, variantE);
```

The static form avoids deeply nested chaining and creates the union in a single call.

## `.merge()` Distribution Over Unions

`.merge()` distributes over unions on both sides. If you merge a union into an object type (or vice versa), the operation is applied to each branch individually:

```typescript
// base.merge(union): distributes merge across each branch
const Result = baseType.merge(type.or({ a: 'string' }, { b: 'number' }));
// Equivalent to: type.or(baseType.merge({ a: 'string' }), baseType.merge({ b: 'number' }))
```

**Constraint**: Each branch of the union must be an object type. If any branch is non-object (e.g., `'string'`), arktype will throw a `ParseError`:

```typescript
// ❌ WRONG: 'string' is not an object type
commandBase.merge(type.or({ a: 'string' }, 'string'));

// ✅ CORRECT: all branches are object types
commandBase.merge(type.or({ a: 'string' }, { b: 'number' }));
```

## Optional Properties in Unions

Use arktype's `'key?'` syntax for optional properties. Never use `| undefined` for optionals because it breaks JSON Schema conversion.

```typescript
// Good: optional property syntax
commandBase.merge({
	action: "'openTab'",
	url: 'string',
	'windowId?': 'string',
	'result?': type({ tabId: 'string' }).or('undefined'),
});

// Bad: explicit undefined union on a required key
commandBase.merge({
	action: "'openTab'",
	url: 'string',
	windowId: 'string | undefined', // Breaks JSON Schema
});
```

The `'result?': type({...}).or('undefined')` pattern is correct. The `?` makes the key optional, and `.or('undefined')` allows the value to be explicitly `undefined` when present. This is the standard pattern for "pending = absent, done = has value" semantics.

## Merge Behavior

- **Override**: When both the base and merge argument define the same key, the merge argument wins
- **Optional preservation**: If a key is optional (`'key?'`) in the base and required in the merge, the merge argument's optionality wins
- **No deep merge**: `.merge()` is shallow. It replaces top-level keys, not nested objects
- **Distributes over unions**: Both the base and the argument can be unions; merge is applied per branch

## Discriminant Detection

Arktype auto-detects discriminants when union branches have distinct literal values on the same key:

```typescript
const AorB = type({ kind: "'A'", value: 'number' }).or({
	kind: "'B'",
	label: 'string',
});

// Arktype internally uses `kind` as the discriminant
// Validation checks `kind` first, then validates only the matching branch
```

This works with any literal type: string literals, number literals, or boolean literals.

## Always Wrap Extracted Types with `type()`

When extracting reusable arktype types into named constants, always wrap them with `type()`, even for simple string literal unions. This ensures the value is a proper arktype `Type` with `.infer`, `.or()`, `.merge()`, etc.

```typescript
// GOOD: wrapped with type(), composable, has .infer, works with .or()/.merge()
const tabGroupColor = type(
	"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
);

const commandBase = type({
	id: CommandId,
	deviceId: DeviceId,
	createdAt: 'number',
	_v: '1',
});

// BAD: plain string, not a Type, can't compose, no .infer
const tabGroupColor =
	"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'";
```

Both work when used as a value inside `type({...})` object literals (arktype coerces strings). But only the `type()`-wrapped version is a first-class `Type` that works in all positions.

## Let Schema Values and Inferred Types Share a Name

When an arktype schema exports both a runtime value and its inferred type with the same name, import that name once. TypeScript keeps value space and type space separate, so the same identifier can validate at runtime and annotate values at compile time.

```typescript
// Good: one import covers both namespaces
import { WorkspaceId } from './workspace-id';

const Session = type({
	workspaceId: WorkspaceId,
});

type SessionResponse = {
	workspaceId: WorkspaceId;
};
```

Avoid aliasing the runtime schema just to make room for the type import.

```typescript
// Bad: duplicates the name with an artificial Schema suffix
import {
	WorkspaceId as WorkspaceIdSchema,
	type WorkspaceId,
} from './workspace-id';

const Session = type({
	workspaceId: WorkspaceIdSchema,
});
```

Reach for an alias only when two imported values genuinely collide in the same namespace. A runtime schema and its inferred type do not collide.

## `type.enumerated()`: Derive Unions from Const Arrays

Use `type.enumerated()` to create string literal unions from existing `as const` arrays. This keeps the workspace schema in sync with app constants automatically.

```typescript
import { type } from 'arktype';

const RECORDING_MODES = ['manual', 'vad', 'upload'] as const;

// Spread the const array into type.enumerated()
const recordingMode = type.enumerated(...RECORDING_MODES);
// Equivalent to: type("'manual' | 'vad' | 'upload'")
```

### Extracting from rich object arrays

When constants are objects with a `name` or `id` field, map first:

```typescript
const OPENAI_TRANSCRIPTION_MODELS = [
	{ name: 'whisper-1', description: '...', cost: '$0.36/hour' },
	{ name: 'gpt-4o-transcribe', description: '...', cost: '$0.36/hour' },
] as const;

const openaiModel = type.enumerated(
	...OPENAI_TRANSCRIPTION_MODELS.map((m) => m.name),
);
```

### In discriminated unions

Combine with `base.merge(type.or(...))` to build unions where each variant's model field derives from its constant array:

```typescript
const transcriptionConfig = type.or(
	{ service: "'OpenAI'", model: type.enumerated(...OPENAI_MODELS.map((m) => m.name)) },
	{ service: "'Groq'", model: type.enumerated(...GROQ_MODELS.map((m) => m.name)) },
	{ service: "'whispercpp'" },  // local: no model field
);
```

### Why derive from constants

- **Single source of truth**: Model lists are maintained in one place: the constant arrays
- **Auto-sync**: Adding a model to the array automatically updates the workspace schema
- **No string drift**: Impossible for the schema to list models that don't exist in the app

## Anti-Patterns

### JS object spread (loses Type composition)

```typescript
// Bad: base is a plain object, not a Type
const baseFields = { id: 'string', deviceId: DeviceId, createdAt: 'number' };
const Command = type({ ...baseFields, action: "'closeTabs'" }).or({
	...baseFields,
	action: "'openTab'",
});
```

This works but `baseFields` is not an arktype `Type`. You can't call `.merge()`, `.or()`, or inspect it at runtime. Prefer `.merge()` when the base should be a proper type.

### Repeating `base.merge(...)` per variant

```typescript
// Bad: repetitive, base.merge repeated for every variant
type.or(
	commandBase.merge({ action: "'closeTabs'", tabIds: 'string[]' }),
	commandBase.merge({ action: "'openTab'", url: 'string' }),
	commandBase.merge({ action: "'activateTab'", tabId: 'string' }),
);

// Good: merge once, union the variants
commandBase.merge(
	type.or(
		{ action: "'closeTabs'", tabIds: 'string[]' },
		{ action: "'openTab'", url: 'string' },
		{ action: "'activateTab'", tabId: 'string' },
	),
);
```

### Forgetting `'key?'` syntax for optionals

```typescript
// Bad: makes windowId required but accepting undefined
commandBase.merge({ windowId: 'string | undefined' });

// Good: makes windowId truly optional
commandBase.merge({ 'windowId?': 'string' });
```

## References

- `.agents/skills/typescript/SKILL.md`: Arktype optional properties section
- [arktype source: merge distributes](https://github.com/arktypeio/arktype/blob/6d0639bf/ark/schema/roots/root.ts#L290-L302): `rNode.distribute()` in merge implementation
