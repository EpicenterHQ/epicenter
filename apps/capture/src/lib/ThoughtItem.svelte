<script lang="ts">
  import { deleteConfirmedThought, moveThought, reorderThought, type Capture, type Thought } from '@epicenter/capture';
  import { Button } from '@epicenter/ui/button';
  import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
  import { toast } from '@epicenter/ui/sonner';
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
  import type { openCapture } from './open.js';
  import TextEditor from './TextEditor.svelte';

  let { store, thought, captures, canMoveUp = false, canMoveDown = false, onError }: {
    store: Awaited<ReturnType<typeof openCapture>>;
    thought: Thought;
    captures: readonly Capture[];
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onError: (message: string) => void;
  } = $props();
  // A keyed item is mounted for one thought and one captured store.
  // svelte-ignore state_referenced_locally
  const body = store.tables.thoughts.body(thought.id);
  const inRecovery = $derived(!captures.some((capture) => capture.id === thought.captureId));
  let destinations = $state<{ id: string; preview: string; capturedAt: string }[]>([]);
  let confirming = $state(false);
  let reviewedText = $state('');
  let deleting = $state(false);

  function refreshDestinations() {
    destinations = captures.filter((capture) => capture.id !== thought.captureId).map((capture) => ({
      id: capture.id,
      preview: store.tables.captures.body(capture.id)?.toString().split(/\r?\n/).find((line) => line.trim())?.trim() || 'Empty capture',
      capturedAt: capture.capturedAt,
    }));
  }
  function move(captureId: string) {
    try {
      moveThought(store, thought.id, captureId);
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
      toast.success('Thought copied');
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

<article class="border-b border-border py-3">
  <div class="flex items-start gap-2">
    {#if body}
      <div class="min-w-0 flex-1"><TextEditor {body} compact label="Thought text" /></div>
    {:else}
      <p role="alert" class="min-w-0 flex-1 py-2">This thought cannot be read yet.</p>
    {/if}
    <DropdownMenu.Root onOpenChange={(open) => { if (open) refreshDestinations(); }}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon-sm" aria-label="Thought actions" class="mt-1">
            <EllipsisIcon class="size-4" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-48">
        {#if !inRecovery}
          <DropdownMenu.Item disabled={!canMoveUp} onclick={() => reorder(-1)}>Move up</DropdownMenu.Item>
          <DropdownMenu.Item disabled={!canMoveDown} onclick={() => reorder(1)}>Move down</DropdownMenu.Item>
          <DropdownMenu.Separator />
        {/if}
        <DropdownMenu.Item onclick={copy}>Copy text</DropdownMenu.Item>
        {#if destinations.length}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>Move to capture</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent class="w-64 max-w-[calc(100vw-2rem)]">
              {#each destinations as destination (destination.id)}
                <DropdownMenu.Item onclick={() => move(destination.id)} class="flex-col items-start gap-0.5">
                  <span class="w-full truncate">{destination.preview}</span>
                  <time class="text-xs text-muted-foreground" datetime={destination.capturedAt}>{new Date(destination.capturedAt).toLocaleString()}</time>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {/if}
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="destructive" onclick={() => { reviewedText = body?.toString() ?? ''; confirming = true; }}>Delete thought…</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
  {#if confirming}
    <section aria-label="Delete thought preview" class="mt-3 rounded border border-destructive p-3">
      <p>Permanently delete this thought?</p>
      <p class="my-2 whitespace-pre-wrap">{reviewedText || 'Empty thought'}</p>
      <div class="flex gap-3 text-sm">
        <Button size="sm" variant="destructive" disabled={deleting} onclick={remove}>{deleting ? 'Saving deletion…' : 'Permanently delete thought'}</Button>
        <Button size="sm" variant="outline" onclick={() => confirming = false}>Cancel</Button>
      </div>
    </section>
  {/if}
</article>
