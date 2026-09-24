<script lang="ts">
  import type { CaptureData, Capture } from '@epicenter/capture';
  import { fromSubscription } from '@epicenter/svelte';

  let { store, capture, open, thoughtCount }: {
    store: CaptureData; capture: Capture; open: (id: string) => void; thoughtCount: number;
  } = $props();
  // svelte-ignore state_referenced_locally
  const body = store.tables.captures.body(capture.id);
  const text = body
    ? fromSubscription((update) => store.tables.captures.watch(body, update), () => body.toString())
    : { current: '' };
  const preview = $derived.by(() => {
    const full = text.current.trim();
    if (!full) return 'Empty capture';
    // Line clamping alone leaves the full document in the button's accessible name.
    const excerpt = full.match(/^.{0,240}/su)?.[0] ?? full;
    return excerpt.length < full.length ? `${excerpt.trimEnd()}…` : excerpt;
  });
</script>

<button type="button" onclick={() => open(capture.id)}
  class="w-full rounded-sm border-b border-border px-2 py-5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-3">
  <time class="block text-xs font-medium text-muted-foreground" datetime={capture.capturedAt}>
    {new Date(capture.capturedAt).toLocaleString()}
  </time>
  <p class="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-base leading-relaxed">{preview}</p>
  {#if thoughtCount > 0}
    <p class="mt-2 text-xs text-muted-foreground">{thoughtCount} {thoughtCount === 1 ? 'thought' : 'thoughts'}</p>
  {/if}
</button>
