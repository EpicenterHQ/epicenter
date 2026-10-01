# Toast On Error

`toastOnError` from `@epicenter/ui/sonner` accepts either a `Result<T, AnyTaggedError>` or a bare `AnyTaggedError`. It shows the tagged error's message and returns its input unchanged.

The call site supplies the short UI title. The error variant owns the detailed description.
The pass-through return is convenient for expressions; it does not mean a caller
should present the failure and then forward it to another presentation owner.
If another caller must decide what the failure means, return the Result without
toasting it here.

## Inspect Data Locally

Destructure the Result, present the error branch, then continue with the narrowed data:

```ts
const { data, error } = await api.billing.portal();
if (error !== null) {
	toastOnError(error, 'Could not open billing portal');
	return;
}
if (data.portalUrl) window.location.href = data.portalUrl;
```

## Fire And Forget

When an event handler does not need pending state or success data, attach presentation before intentionally discarding the Promise:

```ts
void bookmarkState
	.toggle(tab)
	.then((result) => toastOnError(result, 'Failed to toggle bookmark'));
```

This is appropriate only when `toggle` fulfills with a Result rather than rejecting. If the Promise can reject, adapt that rejection at the service boundary first or attach a rejection handler.

Do not combine `await` and `.then(...)` on the same expression.

## Raw Unknown Errors

`toastOnError` requires a tagged error. A raw `catch (cause)` value is `unknown`, so either adapt it into a typed error first or use `toast.error` with `extractErrorMessage` at a local UI boundary:

```ts
try {
	await riskyUiOperation();
} catch (cause) {
	toast.error('Operation failed', {
		description: extractErrorMessage(cause),
	});
}
```

Do not pass `unknown` to `toastOnError` or cast it to `AnyTaggedError`.

## TanStack Mutation Errors

Choose from the mutation's actual error type, not from the fact that TanStack is involved:

- A generic rejected mutation commonly exposes `unknown` or `Error`: use `extractErrorMessage` or adapt it into a tagged error.
- `wellcrafted/query` Result mutation helpers preserve the tagged Result error type: use `toastOnError(error, title)` directly.

```ts
// Created with wellcrafted/query Result mutation options: error is tagged.
resultMutation.mutate(input, {
	onError: (error) => toastOnError(error, 'Failed to save changes'),
});
```

## Custom Toast Options

Call `toast.error` directly when the toast needs an action, duration, identifier, or custom description:

```ts
if (error !== null) {
	toast.error('Could not open settings', {
		description: error.message,
		action: { label: 'Open settings', onClick: openSystemSettings },
	});
}
```

## Decision Table

| Situation | Pattern |
| --- | --- |
| Tagged Result with locally used data | Destructure, guard, `toastOnError(error, title)` |
| Tagged Result with unused success data | `.then((result) => toastOnError(result, title))` |
| Raw `unknown` at a UI boundary | Adapt to a tagged error or use `extractErrorMessage` |
| Typed Result mutation error | `toastOnError(error, title)` |
| Toast needs custom options | `toast.error(...)` |
