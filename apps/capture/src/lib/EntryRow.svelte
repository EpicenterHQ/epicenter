<script lang="ts">
  import type { CaptureData, CaptureEntry } from '@epicenter/capture';
  import { fromSubscription } from '@epicenter/svelte';

  let { store, entry, open }: { store: CaptureData; entry: CaptureEntry; open: (id: string) => void } = $props();
  // A keyed row is mounted for one entry and one captured store.
  // svelte-ignore state_referenced_locally
  const body = store.tables.entries.body(entry.id);
  const preview = body
    ? fromSubscription((update) => store.tables.entries.watch(body, update), () => body.toString())
    : { current: '' };
</script>

<button type="button" onclick={() => open(entry.id)}
  class="w-full border-b border-border px-1 py-4 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2">
  <p class="line-clamp-2 whitespace-pre-wrap text-base">{preview.current.trim() || 'Empty capture'}</p>
  <time class="mt-2 block text-xs text-muted-foreground" datetime={entry.capturedAt}>
    {new Date(entry.capturedAt).toLocaleString()}
  </time>
</button>
