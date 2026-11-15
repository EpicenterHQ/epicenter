# Mutation examples

Use these examples when a component needs a complete asynchronous interaction,
not just a hook declaration. [Query-layer](../../query-layer/SKILL.md) owns
options, submission inputs, shared identity, invalidation, and mutation callback
scope and ordering. [Input ownership](input-ownership.md) owns native
controls, reactive drafts, and commit-on-blur.

The app-local operations and report names below are illustrative. Adapt them to
the actual app; they are not the removed Whispering query-adapter API.

## Choose the component operation owner

`createMutation` is the component operation lifecycle primitive. It is not
reserved for cache invalidation, retry policy, or shared mutation keys. Use it
when the template observes the operation's pending, error, success, or data.

Refreshing reads after a write is the QueryClient's invalidation rule, not a
reason to share a definition. Use a shared entry when several consumers share
the operation's identity, optimistic behavior, or mutation-state observation.
For a local operation, `createMutation` gives the component a standard
pending/error/success surface without pretending the operation is shared
query-layer state.

## Async download button

In this illustrative app, another consumer shares the Result-returning
download operation, which accepts `{ id }`. The app exports its options once:

```ts
// $lib/query.ts
import { resultMutations } from 'wellcrafted/query';
import { downloadRecording } from '$lib/operations/download-recording';

export const recordingMutations = resultMutations(['recordings'], {
  download: downloadRecording,
});
```

Namespace mutations are options entries, so the component passes the entry
directly without an `.options` hop:

```svelte
<script lang="ts">
  import { createMutation } from '@tanstack/svelte-query';
  import { Button } from '@epicenter/ui/button';
  import { Spinner } from '@epicenter/ui/spinner';
  import { recordingMutations } from '$lib/query';
  import { report } from '$lib/report';

  let { recording }: { recording: { id: string } } = $props();
  const download = createMutation(() => recordingMutations.download);
</script>

<Button
  onclick={() => {
    const id = recording.id;
    download.mutate({ id }, {
      onSuccess: () => report.success({ title: 'Recording downloaded' }),
      onError: (error) => report.error({
        title: 'Could not download recording',
        cause: error,
      }),
    });
  }}
  disabled={download.isPending}
>
  {#if download.isPending}<Spinner class="size-3.5" />{/if}
  {download.isPending ? 'Downloading...' : 'Download'}
</Button>
```

Name a mutation for its action, without a `Mutation` suffix. These per-call
toasts belong to the latest mounted interaction. They may be skipped after
unmount or a newer call. Put work required for every execution in the operation,
mutation options, or that call's `mutateAsync` continuation. A disabled button
does not itself establish synchronous admission of at most one call.

Reuse the app's existing entry when it already owns this shared operation.
Import personal apps' components through their own copied component boundary.

## Component-local export

For an operation observed only by this component, keep the function local to
its operation module and wrap it with `resultMutationOptions`. The illustrative
`exportRecordingsMarkdown` returns a Result whose successful data is either
`{ status: 'cancelled' }` or `{ status: 'written', written: number, dir: string }`.
It owns its export work and any stable service dependencies.

```svelte
<script lang="ts">
  import { createMutation } from '@tanstack/svelte-query';
  import { resultMutationOptions } from 'wellcrafted/query';
  import { Button } from '@epicenter/ui/button';
  import { Spinner } from '@epicenter/ui/spinner';
  import { exportRecordingsMarkdown } from '$lib/operations/recordings-markdown';
  import { report } from '$lib/report';

  const exportMarkdown = createMutation(() => resultMutationOptions({
    mutationKey: ['recordings', 'exportMarkdown'],
    mutationFn: () => exportRecordingsMarkdown(),
  }));
</script>

<Button
  onclick={() => exportMarkdown.mutate(undefined, {
    onSuccess: (data) => {
      if (data.status === 'cancelled') return;
      report.success({
        title: 'Recording markdown exported',
        description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
      });
    },
    onError: (error) => report.error({
      title: 'Recording markdown export failed',
      cause: error,
    }),
  })}
  disabled={exportMarkdown.isPending}
>
  {#if exportMarkdown.isPending}<Spinner class="size-3.5" />{/if}
  {exportMarkdown.isPending ? 'Exporting...' : 'Export markdown...'}
</Button>
```

The cancellation answer is a successful choice to do no export, so it needs no
success toast. Capture changing record identity, input, or reviewed versions in
the interaction handler and pass them as mutation variables when the operation
depends on them. A closure over a stable app service is different from reading
live form values later inside the mutation function.

Do not create a shared query adapter only to obtain `isPending` for this one
control. The local wrapper supplies the lifecycle. Keep essential export
cleanup with the operation; its completion must not depend on this component's
per-call toast callbacks running.

## Direct await and the promotion point

Direct `await` fits an interaction whose template reads no operation lifecycle:

```svelte
<Button onclick={async () => {
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    report.error({ title: 'Could not copy text', cause: error });
  }
}}>
  Copy
</Button>
```

This terminal handler presents the browser API's expected DOM failures;
unexpected exceptions still propagate. A reusable copy operation can adapt
those failures into a Result, which the handler then consumes.

If the next edit adds `disabled={isCopying}`, a spinner, or loading text,
promote the action to `createMutation` instead of adding a one-off `$state`
pending flag. A final toast can consume a Result in the handler without a
mutation. Existing capabilities may already own their operation state; read
that owner rather than duplicate it.

Outside component context, or for a sequential workflow, use direct `await`,
`mutateAsync`, or `runMutation(queryClient, entry, input)` as appropriate.
`runMutation` executes the same options through the mutation cache and returns
a Result. Do not resurrect a callable shared-entry API that the current query
factories do not expose.

For when a handler should stay inline or earn a name, see
[single-use functions and aliases](component-ui-patterns.md#single-use-functions-and-aliases).
