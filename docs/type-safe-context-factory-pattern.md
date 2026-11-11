# The Factory Pattern for Type-Safe Co-located Functions

When you have related functions. A getter and a setter, a producer and a consumer, or any pair that shares types. You have two options. You can export them separately, or you can use a factory pattern that returns them together.

The factory pattern is better for type safety.

## Svelte Context

Svelte used to export `getContext` and `setContext`, which you would import and then wrap with your own type-safe helpers:

```typescript
// Before (10 lines)
import { getContext, setContext } from 'svelte';
export function setToggleGroupCtx(props: ToggleVariants) {
	setContext('toggleGroup', props);
}
export function getToggleGroupCtx() {
	return getContext<ToggleVariants>('toggleGroup');
}
```

Then Svelte added `createContext`, a factory function that returns type-safe get and set functions as a tuple:

```typescript
// After (2 lines)
import { createContext } from 'svelte';
export const [getToggleGroupCtx, setToggleGroupCtx] =
	createContext<ToggleVariants>();
```

The before version has implicit relationships. The getter and setter happen to share a key and type, but nothing enforces that. You have to manually keep the string key and type annotation in sync.

The after version makes the relationship structural. The factory handles the key internally and returns paired functions. The type parameter flows through both. No string keys to keep in sync, no possibility of mismatch.

See the migration in practice:
- [shadcn-svelte PR #2445](https://github.com/huntabyte/shadcn-svelte/pull/2445)
- [shadcn-svelte PR #2446](https://github.com/huntabyte/shadcn-svelte/pull/2446)

## Tagged Errors

In wellcrafted, you could manually create error constructor functions that share a tag:

```typescript
// Before
import { Err, Error } from 'wellcrafted/result';
function GmailAuthErr(args: Args) {
	return Err({ tag: 'GmailAuthError' as const, ...args });
}
function GmailAuthError(args: Args) {
	return Error({ tag: 'GmailAuthError' as const, ...args });
}
```

The `createTaggedError` factory returns both the `Err`-wrapped version and the raw error constructor, with the tag defined once:

```typescript
// After
import { createTaggedError } from 'wellcrafted/error';
const { GmailAuthErr, GmailAuthError } = createTaggedError('GmailAuthError');
```

The tag string is defined once and flows through both. You can't accidentally use the wrong tag or mismatched Args types.

## Svelte Two-Way Binding

With separate `value` and `onchange` props, the types can diverge between the getter and setter:

```svelte
<!-- Before: separate props, types can diverge -->
<Select
	value={settings.value['transcription.openai.model']}
	onchange={(v) => settings.updateKey('transcription.openai.model', v)}
/>
```

The `bind:value` syntax with getter and setter functions co-locates them in a single binding:

```svelte
<!-- After: getter and setter co-located in bind syntax -->
<Select
	bind:value={
		() => settings.value['transcription.openai.model'],
		(v) => settings.updateKey('transcription.openai.model', v)
	}
/>
```

When you use `bind:value` with a getter and setter function, the type flows through both directions automatically. It's the same principle. Co-location ensures type safety.

## Query Factories

Wellcrafted's query API takes no client. `resultQueries` and `resultMutations` turn a service's Result-returning methods into TanStack options; `resultQueryOptions` and `resultMutationOptions` adapt one function. Hooks take their client from the provider, and `runQuery` and `runMutation` take it as an argument.

```typescript
import { resultMutations, resultQueries } from 'wellcrafted/query';

const userQueries = resultQueries(['users'], { get: services.getUser });
const userMutations = resultMutations(['users'], { save: services.saveUser });

const user = createQuery(() => userQueries.get(userId));
const save = createMutation(() => userMutations.save);
```

A factory still earns its place when the options close over a per-session transport. Build the maps inside the session constructor, beside the QueryClient that session owns, as `createDashboardRuntime(account)` does in `apps/api/ui`. The options and the client then share one lifetime.

## When to Use It

Use a factory when:

- You have a getter and a setter
- You have functions that share types
- You want to annotate that functions belong together

If functions are related and you want that relationship to be explicit in the code structure, return them from a factory instead of exporting them separately.
