<script lang="ts">
  import type { CaptureData, Capture } from '@epicenter/capture';
  import { fromSubscription } from '@epicenter/svelte';

  let { store, capture, open }: {
    store: CaptureData; capture: Capture; open: (id: string) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const body = store.tables.captures.body(capture.id);
  const text = body
    ? fromSubscription((update) => store.tables.captures.watch(body, update), () => body.toString())
    : { current: '' };
  const preview = $derived(text.current.split(/\r?\n/).find((line) => line.trim())?.trim() || 'Empty capture');
</script>

<button type="button" onclick={() => open(capture.id)}
  class="w-full border-b border-border px-1 py-4 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2">
  <p class="line-clamp-2 whitespace-pre-wrap text-base">{preview}</p>
  <time class="mt-2 block text-xs text-muted-foreground" datetime={capture.capturedAt}>
    {new Date(capture.capturedAt).toLocaleString()}
  </time>
</button>
