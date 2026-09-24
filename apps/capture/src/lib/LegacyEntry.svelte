<script lang="ts">
  import type { CaptureData } from '@epicenter/capture';
  import { fromSubscription } from '@epicenter/svelte';

  let { store, entry }: {
    store: CaptureData; entry: CaptureData['tables']['entries']['rows'][number];
  } = $props();
  // svelte-ignore state_referenced_locally
  const body = store.tables.entries.body(entry.id);
  const text = body
    ? fromSubscription((update) => store.tables.entries.watch(body, update), () => body.toString())
    : { current: '' };
  let copied = $state(false);
  let copyError = $state(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text.current);
      copied = true;
      copyError = false;
    } catch {
      copyError = true;
    }
  }
</script>

<article class="border-b border-border py-4">
  <time class="text-xs text-muted-foreground" datetime={entry.capturedAt}>{new Date(entry.capturedAt).toLocaleString()}</time>
  {#if entry.parentId}<p class="text-xs text-muted-foreground">Earlier parent: {entry.parentId}</p>{/if}
  <p class="my-2 whitespace-pre-wrap">{text.current || 'Empty entry'}</p>
  <button type="button" class="text-sm underline" onclick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
  {#if copyError}<p role="alert" class="text-sm">Copy failed. Select the text above to copy it.</p>{/if}
</article>
