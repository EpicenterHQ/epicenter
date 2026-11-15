# Immediate editing and explicit submission

Choose the product's acceptance boundary before choosing the input owner.
When that behavior is unsettled, use
[product-collapse](../../product-collapse/SKILL.md) to decide what should be
accepted on typing, blur, change, or Submit, and which unfinished work should
survive leaving. The guidance below implements that choice.

Choose between an editor that accepts input immediately and a form that keeps
input until submission. Within a form, a binding used only to fetch text on
Submit is a removal candidate; live previews need a reactive reader, and focus
or selection refs have separate interaction work to do.

## Immediate editing

Bind accepted input to its existing editor rather than synchronizing another
draft with effects. Gate structured controls on valid content; codecs transform
representations without becoming content owners. For contract apps, follow
[contract reads and editing](lifecycle-and-reactivity.md#contract-reads-and-editing)
for editor construction, field binding, and save lifetime.

## Explicit submission

The form owns input that has not been submitted. Choose where that input lives
by who needs to read it and how long it must survive.

Use [query-layer's submission rule](../../query-layer/SKILL.md):
read the controls synchronously and pass the submitted values onward. A bound
draft can keep changing while that operation stays fixed.
Preserve failed input for retry unless the form deliberately discards it.
Clear input after success only if it still belongs to that
submission, or disable editing while pending. An older request must not erase
newer typing.

Keep the raw submitted value when a completion callback compares it with the
current input. Compare raw input with raw input; normalization such as trimming
can make a newer edit look unchanged.

When a callback can outlive its control or selection, matching text alone does
not establish ownership. A phrase can change from A to B and back to A while an
older save runs. Use the existing record, control, or selection-session identity
to decide whether that result may clear input. A whole-form reset needs the same
guarantee for every field it resets. Keep these checks where those lifetime
changes are possible; a fixed form with editing disabled need not acquire a new
revision protocol.

### Native controls

When only submission reads the input, prefer letting the browser hold it.
On blur or change, read `event.currentTarget.value`. At Submit, read a native
element reference or named controls through `FormData`. Choose the read that
makes the complete form simplest; native ownership does not require FormData.

In Svelte 5, [`bind:this`](https://svelte.dev/docs/svelte/bind#bind:this) still
provides a DOM reference. A plain `let` can hold a ref read only by handlers.
Direct bindings to it can produce `non_reactive_update` in conditional blocks
or component prop bindings, such as a wrapper's `bind:ref`. For an imperative-only
ref, a function binding such as `bind:ref={() => field, (node) => field = node}`
provides an explicit read/write path. Keep the getter: `bind:this` needs it to
clear the correct reference on destruction. Use reactive state when readers
need to observe changes to the reference.
Read refs after mounting. A component's `bind:this` yields its instance, so
use its documented element-reference API when you need the underlying input.
For values with reactive readers, `bind:value={draft}` remains supported;
[`bind:value={get, set}`](https://svelte.dev/docs/svelte/bind#Function-bindings)
(5.9+) reads and writes through an existing owner or transformation. Function
bindings do not replace `bind:this` or make the DOM's `.value` reactive.

Native constraint validation and submit-time validation do not require a
reactive draft. This illustrative text form assumes `createItem` is the app's
operation:

```svelte
<script lang="ts">
  import { createMutation } from '@tanstack/svelte-query';

  const create = createMutation(() => ({ mutationFn: createItem }));
  let titleInput: HTMLInputElement;
</script>

<form onsubmit={(event) => {
  event.preventDefault();
  if (create.isPending) return;
  const form = event.currentTarget;
  const title = titleInput.value.trim();

  create.mutate({ title }, { onSuccess: () => form.reset() });
}}>
  <label for="item-title">Title</label>
  <input id="item-title" bind:this={titleInput} required disabled={create.isPending} />
  <button type="submit" disabled={create.isPending}>Create</button>
  {#if create.error}<p role="alert">{create.error.message}</p>{/if}
</form>
```

The DOM owns unfinished text; the mutation owns the captured submission and
request state.

FormData is useful for multi-field forms, files, and standard form submissions.
Its entries are `string | File`, and `get` can return `null`. Parse the entries
according to the action's input. Use an empty fallback only when absence means
empty; `String(value ?? '')` can hide a missing control or stringify a file.
Avoid a ref for every field when reading the form together is clearer.

Capture any element needed by a later callback in the handler. An event's
[`currentTarget`](https://developer.mozilla.org/en-US/docs/Web/API/Event/currentTarget)
does not remain available after dispatch. Read
[FormData](https://developer.mozilla.org/en-US/docs/Web/API/FormData/FormData)
before disabling controls; unnamed and disabled controls are omitted.

A new-entry form can use `form.reset()`; reset restores control defaults, so
choose those deliberately.
Native input lasts only as long as its element. For an existing record, decide
what a changed server value or remount may replace, and verify that behavior.

### Commit-on-blur

Blur can be the submission event for an individual field:

```svelte
<input
  value={entry.title}
  onblur={(event) => {
    const next = event.currentTarget.value;
    if (next !== entry.title) updateEntry({ title: next });
  }}
/>
```

This example skips unchanged-looking input, so visiting a field does not write
a stale cached value over another writer's change. It can also skip a deliberate
submission matching that cached value. If blur itself always means Submit,
send the value directly and let the action decide whether a write is needed.
Neither policy resolves competing writes.

Capture and dispatch in the blur handler; deferring dispatch through an await,
timer, or animation frame can miss a closing page. Dispatch does not guarantee
completion before teardown. Keep any durable-save requirement with an owner
that provides it.

Immediate editors already accept typing; they need no extra blur commit.
Discrete selectors submit on their change event, search filters need their own
reactive value, and explicit forms submit through their form handler.

### Reactive drafts

Keep a reactive draft when markup or computed state observes typing, other views
share unfinished input, or a stated policy preserves it across refreshes or
unmounting. Search filters and live previews have reactive readers; they still
need reactive input. Give input that must outlive the component an owner above
it.

For fields sent together, one draft object shaped like the API input can keep
submission direct. Use ordinary `$state` for in-place edits and direct property
bindings, or `$state.raw` for replace-only edits. The example below uses raw
state because each edit replaces the object: the captured submission stays
fixed while the live preview follows later typing.

```svelte
<script lang="ts">
  let draft = $state.raw({ title: '', text: '' });
</script>

<form onsubmit={(event) => {
  event.preventDefault();
  const submitted = draft;
  void api.create(submitted);
}}>
  <Input bind:value={
    () => draft.title,
    (title) => draft = { ...draft, title }
  } />
  <Textarea bind:value={
    () => draft.text,
    (text) => draft = { ...draft, text }
  } />
  <Button type="submit">Create</Button>
</form>

<article aria-label="Preview">
  <h2>{draft.title}</h2>
  <p>{draft.text}</p>
</article>
```

This is ownership pseudocode; the real handler presents failure and decides
whether to clear or close on success.

A single-field form may use a single-value `$state`. Do not manufacture an object
only to wrap one string, or combine unrelated forms and visibility flags into
one object. An explicit-submit form editing an existing record may initialize
from it once for that form lifetime. Cancel discards that draft. Reopening or
keying a different record chooses a new starting value; an effect should not
silently replace unfinished input from live record updates.

Keep validation, normalization or mapping when the API needs a different shape.
Avoid building another identical payload from parallel field variables at
Submit.

## Raw, snapshot and freezing

`$state.raw` stores a value without deep proxying. Use it for replace-only draft
objects. Replace changed nested objects as well; `draft.title = text` and
`draft.tags.push(tag)` do not notify raw-state readers. Raw state is not frozen.
A raw object containing previously proxied values is not automatically plain.

Ordinary `$state` is appropriate for intentional property mutation and direct
property bindings. At a boundary that needs plain data, capture
`const submitted = $state.snapshot(draft)` and submit that value. A snapshot is
not a read-only or frozen object either. There is no current `$state.frozen` API.

Apply [query-layer's snapshot test](../../query-layer/SKILL.md)
before adding detachment: a plain raw draft replaced on every edit may already
preserve the submitted object. The installed Svelte declarations describe raw
and snapshot in `svelte/types/index.d.ts`.

## Search recipes

Search application consumers first, then follow their readers, mutations, and
cleanup. Matches identify candidates; they do not establish redundant ownership.
Adapt the roots to the checkout, including a personal app's `ui/src`.

```sh
# Candidate owners and binding mirrors.
rg -n -g '*.svelte' -g '*.svelte.ts' '\$state|bind:|getValue|setValue|onValueChange' apps

# Acquisition and submission boundaries.
rg -n -g '*.svelte' -g '*.svelte.ts' 'onsubmit=|onblur=|FormData|mutate\(|mutateAsync\(' apps

# Explicit copies and completion cleanup.
rg -n -g '*.svelte' -g '*.svelte.ts' '\$state\.snapshot|structuredClone|reset\(|onSuccess|onSettled' apps
```

Apply the [state and handler defaults](../SKILL.md#state-and-handler-defaults)
to each candidate. Inspect alias and nested writes before concluding that a
passed object is stable, and trace reset ownership before removing a guard.
