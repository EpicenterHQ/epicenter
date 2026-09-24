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
  class="w-full rounded-sm border-b border-border px-2 py-5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-3">
  <time class="block text-xs font-medium text-muted-foreground" datetime={capture.capturedAt}>
    {new Date(capture.capturedAt).toLocaleString()}
  </time>
  <p class="mt-2 line-clamp-2 whitespace-pre-wrap text-base leading-relaxed">{preview}</p>
</button>
