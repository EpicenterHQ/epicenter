<script lang="ts">
  import { deleteConfirmedThought, moveThought, reorderThought, type CaptureData, type Capture, type Thought } from '@epicenter/capture';
  import type { openCapture } from './open.js';
  import TextEditor from './TextEditor.svelte';

  let { store, thought, captures, onError }: {
    store: Awaited<ReturnType<typeof openCapture>>;
    thought: Thought;
    captures: readonly Capture[];
    onError: (message: string) => void;
  } = $props();
  // A keyed item is mounted for one thought and one captured store.
  // svelte-ignore state_referenced_locally
  const body = store.tables.thoughts.body(thought.id);
  const inRecovery = $derived(!captures.some((capture) => capture.id === thought.captureId));
  let destination = $state('');
  let confirming = $state(false);
  let reviewedText = $state('');
  let deleting = $state(false);

  function move() {
    if (!destination) return;
    try {
      moveThought(store, thought.id, destination);
      destination = '';
      onError('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not move this thought.');
    }
  }
  function reorder(direction: -1 | 1) {
    try { reorderThought(store, thought.id, direction); onError(''); }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Could not reorder this thought.'); }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(body?.toString() ?? '');
      onError('');
    } catch {
      onError('Could not copy this thought. You can select its text and copy it.');
    }
  }
  async function remove() {
    if (deleting) return;
    deleting = true;
    try {
      await deleteConfirmedThought(store, thought.id, reviewedText);
      confirming = false;
      onError('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not delete this thought.');
      reviewedText = body?.toString() ?? '';
    } finally { deleting = false; }
  }
</script>

<article class="border-b border-border py-5">
  {#if body}
    <TextEditor {store} {body} kind="thoughts" label="Thought text" />
  {:else}
    <p role="alert">This thought cannot be read yet.</p>
  {/if}
  <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
    {#if !inRecovery}
      <button type="button" class="underline" onclick={() => reorder(-1)}>Move up</button>
      <button type="button" class="underline" onclick={() => reorder(1)}>Move down</button>
    {/if}
    <button type="button" class="underline" onclick={copy}>Copy text</button>
    <label>Move to
      <select aria-label="Move thought to capture" bind:value={destination} class="ml-1 rounded border border-border bg-background p-1">
        <option value="">Choose capture</option>
        {#each captures.filter((capture) => capture.id !== thought.captureId) as capture (capture.id)}
          <option value={capture.id}>{store.tables.captures.body(capture.id)?.toString().split(/\r?\n/).find((line) => line.trim()) || 'Empty capture'}</option>
        {/each}
      </select>
    </label>
    <button type="button" disabled={!destination} class="underline disabled:opacity-40" onclick={move}>Move</button>
    <button type="button" class="text-destructive underline" onclick={() => { reviewedText = body?.toString() ?? ''; confirming = true; }}>Delete thought…</button>
  </div>
  {#if confirming}
    <section aria-label="Delete thought preview" class="mt-3 rounded border border-destructive p-3">
      <p>Permanently delete this thought?</p>
      <p class="my-2 whitespace-pre-wrap">{reviewedText || 'Empty thought'}</p>
      <div class="flex gap-3 text-sm">
        <button type="button" disabled={deleting} class="text-destructive underline" onclick={remove}>{deleting ? 'Saving deletion…' : 'Permanently delete thought'}</button>
        <button type="button" class="underline" onclick={() => confirming = false}>Cancel</button>
      </div>
    </section>
  {/if}
</article>
