# Immediate editing and explicit submission

Choose the owner by when input becomes accepted application content. These are
the two default content-input patterns. They do not classify every rune: dialog
visibility, selection, request outcomes and widget history have other jobs.
Judge the information and coordination each owner carries, not the rune count.

## Immediate editing

The editor owns accepted input and publication. Controls read its current value
and send complete replacements to its setter. Do not copy that input into a
component draft and synchronize the two with effects.

| Control | Read | Write |
| --- | --- | --- |
| Complete file text | Current editor text | `fileEdit.replaceText(text)` |
| Structured field | Current valid Markdown fields | `fileEdit.change({ fields: { title } })` |
| Markdown body | Current Markdown body | `fileEdit.change({ body })` |

Render structured controls only while the current row is valid. Invalid rows
show a reason and a Files repair action; do not invent empty field values.
When a binding getter needs narrowed Markdown, capture it with `{@const}` in
the nearest template scope, then narrow that local before creating the binding
callbacks. The setter calls `fileEdit.change()` with the named change; the edit
owner applies it to the live source in call order. Do not spread a render-time
row back into the source or merge it with outside changes in the control.
These data-shape checks are not view permissions.

Real bindings preserve file newlines and present refusal or save errors according
to the app's policy. Accepted input whose save fails stays with its editor, above
disposable controls. Codecs transform representations; they do not become another
current-content owner.

## Explicit submission

The form owns input that has not been submitted. Prefer one draft object for
fields sent together, shaped like the API input. Replace it with a spread when
editing one field, then pass the captured object to the API at Submit.

```svelte
<script lang="ts">
  let draft = $state.raw({ title: '', text: '' });
</script>

<form onsubmit={(event) => {
  event.preventDefault();
  void api.create(draft);
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
```

This is ownership pseudocode; the real handler presents failure and decides
whether to clear or close on success. Capture the submission before awaiting.
Clear the draft after success only if it is still that submission, or disable
editing during the request. Never erase newer typing when an older request ends.
Keep failed unsubmitted input until retry or deliberate discard.

A single-field form may use a single-value `$state`. Do not manufacture an object
only to wrap one string, or combine unrelated forms and visibility flags into
one object. An explicit-submit form editing an existing record may initialize
from it once for that form lifetime. Cancel discards that draft. Reopening or
keying a different record chooses a new starting value; an effect should not
silently replace unfinished input from live record updates.

Keep validation, normalization or mapping when the API needs a different shape.
Avoid building another identical payload from parallel field variables at
Submit. A custom draft owner earns its place when several views share unfinished
input or when a named merge/reset policy requires it.

## Raw, snapshot and freezing

`$state.raw` stores a value without deep proxying. Use it for replace-only draft
objects. Replace changed nested objects as well; `draft.title = text` and
`draft.tags.push(tag)` do not notify raw-state readers. Raw state is not frozen.
A raw object containing previously proxied values is not automatically plain.

Ordinary `$state` is appropriate for intentional property mutation and direct
property bindings. At a boundary that needs plain data, capture
`const submitted = $state.snapshot(draft)` and submit that value. A snapshot is
not a read-only or frozen object either. There is no current `$state.frozen` API.

A plain replace-only raw draft can be passed directly when the API accepts its
shape and does not mutate it. Do not add snapshot, structuredClone, JSON
round-tripping or Object.freeze by habit. Keep a copy when an API retains mutable
input, needs plain data, or requires detachment; name which boundary needs it.
The installed Svelte declarations describe raw and snapshot in
`svelte/types/index.d.ts`.

## Search recipes

Run these from the repository root. Search application source first, then follow
its owners and callers. These queries find candidates; text matches cannot prove
ownership, state mutation or an async race. Exclude fixtures and tests when
triaging, then read tests for the candidate's behavior.

```sh
# Copied editor content and synchronization effects.
rg -n -g '*.svelte' -g '*.svelte.ts' '\$state(\.raw)?|\$effect|syncedBody|localTitle|localBody|acceptedBody' apps

# Explicit submission events and candidate draft/payload owners.
rg -n -g '*.svelte' -g '*.svelte.ts' 'onsubmit=|on:submit|onblur=|handleSubmit|submitForm|initialValues|defaultValues|\b(draft|form|payload|submitted)\b' apps

# Proxy conversion, copies and freezing at a submission boundary.
rg -n -g '*.svelte' -g '*.svelte.ts' '\$state\.(raw|snapshot|frozen)|structuredClone\(|JSON\.parse\(JSON\.stringify|Object\.freeze\(' apps

# Property mutation to inspect alongside the owner's raw-state declaration.
rg -n -g '*.svelte' -g '*.svelte.ts' '\b(draft|form|values)\.[[:alnum:]_.]+[[:space:]]*(=|\+=|\+\+)|\.(push|splice|sort|reverse)\(' apps

# Late results that might clear or overwrite a newer draft.
rg -n -g '*.svelte' -g '*.svelte.ts' 'await|submitted|reset\(|draft =|form =|\.then\(' apps

# Binding wrappers and source/form interpretation state.
rg -n -g '*.svelte' -g '*.svelte.ts' 'getValue|setValue|onValueChange|BoundText|SourceEditor|rawMode|preferView|shownView|showSource|editSource|Tabs\.Content' apps
```

For a raw mutation candidate, inspect all writes, including aliases, nested
objects, bind:value and methods. For a copied-content candidate, trace acquisition,
rendering, setters and submission together. Ask:

- Is this immediate input or an unfinished submission?
- Who owns the current value, and what event accepts it?
- Does another draft or payload duplicate that value?
- Which real information would disappear if this state were removed?
- Can a late response reset newer input or address a different record?

Record a candidate as a grounded change, a policy decision, or a value to keep.
Do not replace a real accepted-content owner, rich widget document/history,
selection session, failure receipt or request identity with a getter merely
because it uses `$state`. Two default input patterns are not a reason to erase
other application information.
