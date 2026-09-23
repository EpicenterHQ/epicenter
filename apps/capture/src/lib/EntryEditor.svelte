<script lang="ts">
  import type * as Y from '@y/y';
  import { onMount } from 'svelte';
  import type { CaptureData } from '@epicenter/capture';

  let { store, body }: { store: CaptureData; body: Y.Node } = $props();
  let textarea: HTMLTextAreaElement;
  let composing = false;

  function applyInput() {
    if (composing) return;
    const before = body.toString();
    const after = textarea.value;
    if (before === after) return;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let oldEnd = before.length;
    let newEnd = after.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    // One positional edit preserves text that a peer changed elsewhere.
    body.applyDelta(body.change.retain(start).delete(oldEnd - start).insert(after.slice(start, newEnd)) as never);
  }

  onMount(() => {
    textarea.value = body.toString();
    const update = () => {
      const value = body.toString();
      if (textarea.value === value) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = value;
      textarea.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
    };
    const stop = store.tables.entries.watch(body, update);
    return stop;
  });
</script>

<textarea
  bind:this={textarea}
  aria-label="Entry text"
  placeholder="Write here…"
  class="min-h-52 w-full resize-y rounded-lg border border-border bg-transparent p-4 text-base leading-relaxed outline-none focus:border-foreground"
  oninput={applyInput}
  oncompositionstart={() => composing = true}
  oncompositionend={() => { composing = false; applyInput(); }}
></textarea>
