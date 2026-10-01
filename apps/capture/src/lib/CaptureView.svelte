<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CAPTURE_PROMOTION_CHANNEL, PromotionInspectionRequired, captureView, createCapture, createPromotedCapture, createThought, deleteConfirmedCapture, previewCaptureDeletion, type CapturePromotionMessage } from '@epicenter/capture';
  import { InstantString } from '@epicenter/app/field';
  import type { Account } from '@epicenter/auth';
  import { fromData } from '@epicenter/svelte';
  import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
  import { AccountPopover } from '@epicenter/app-shell/account-popover';
  import { Button } from '@epicenter/ui/button';
  import * as Card from '@epicenter/ui/card';
  import * as Dialog from '@epicenter/ui/dialog';
  import { Textarea } from '@epicenter/ui/textarea';
  import { auth } from './auth.svelte.js';
  import { onMount } from 'svelte';
  import type { openCapture } from './open.js';
  import CaptureRow from './CaptureRow.svelte';
  import ThoughtItem from './ThoughtItem.svelte';
  import LegacyEntry from './LegacyEntry.svelte';
  import TextEditor from './TextEditor.svelte';

  let { store, account }: { store: Awaited<ReturnType<typeof openCapture>>; account: Account } = $props();
  // AppBoot mounts this view for one captured Account and owns its handle.
  // svelte-ignore state_referenced_locally
  const data = fromData(store);
  const view = $derived(captureView(data));
  const selectedId = $derived(page.url.searchParams.get('capture'));
  const selected = $derived(selectedId ? view.byId.get(selectedId) : undefined);
  const selectedThoughts = $derived(selected ? view.thoughts.get(selected.id) ?? [] : []);
  const body = $derived(selected ? data.tables.captures.body(selected.id) : undefined);
  const saveStatus = $derived(data.persistence.get());
  let captureDraft = $state('');
  let captureDialogOpen = $state(false);
  let captureError = $state('');
  let recoveryExpanded = $state(false);
  let thoughtDrafts = $state<Record<string, string>>({});
  const thoughtDraft = $derived(selected ? thoughtDrafts[selected.id] ?? '' : '');
  function setThoughtDraft(value: string) { if (selected) thoughtDrafts[selected.id] = value; }
  let error = $state('');
  let deletion = $state.raw<ReturnType<typeof previewCaptureDeletion> | null>(null);
  let previewChanged = $state(false);
  let deleting = $state(false);

  function open(id: string | null) {
    deletion = null;
    if (id) captureDialogOpen = false;
    const url = new URL(location.href);
    if (id) url.searchParams.set('capture', id);
    else url.searchParams.delete('capture');
    return goto(url.pathname + url.search);
  }

  function addCapture(event: SubmitEvent) {
    event.preventDefault();
    try {
      const id = createCapture(data, captureDraft).id;
      captureDraft = '';
      captureError = '';
      void open(id);
      error = '';
    } catch (cause) {
      captureError = cause instanceof Error ? cause.message : 'Could not save this capture.';
    }
  }

  function addThought(event: SubmitEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      createThought(data, selected.id, thoughtDraft);
      setThoughtDraft('');
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this thought.';
    }
  }

  onMount(() => {
    const channel = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
    let disposed = false;
    const opening = new Map<string, Promise<void>>();
    channel.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (disposed || auth.getState().account !== account || store.signal.aborted) return;
      if (message.account?.authorityId !== account.authorityId ||
          message.account.principalId !== account.principalId) return;
      if (message.type === 'open') {
        if (!data.tables.captures.get(message.captureId)) {
          channel.postMessage({ type: 'unavailable', requestId: message.requestId,
            account: message.account, captureId: message.captureId } satisfies CapturePromotionMessage);
          return;
        }
        let opened = opening.get(message.requestId);
        if (!opened) {
          opened = open(message.captureId);
          opening.set(message.requestId, opened);
        }
        void opened.then(() => {
          if (disposed || auth.getState().account !== account || store.signal.aborted) return;
          channel.postMessage({ type: 'opened', requestId: message.requestId,
            account: message.account, captureId: message.captureId } satisfies CapturePromotionMessage);
          setTimeout(() => opening.delete(message.requestId), 21_000);
        }, () => opening.delete(message.requestId));
        return;
      }
      if (message.type !== 'add' || typeof message.requestId !== 'string' ||
          typeof message.text !== 'string' || !InstantString.is(message.capturedAt)) return;
      void (async () => {
        try {
          const captureId = createPromotedCapture(data, message);
          if (!data.tables.captures.get(captureId)) {
            channel.postMessage({ type: 'unavailable', requestId: message.requestId,
              account: message.account, captureId } satisfies CapturePromotionMessage);
            return;
          }
          await store.persistence.flush();
          if (disposed || store.signal.aborted || store.persistence.get() !== 'saved' ||
              auth.getState().account !== account) return;
          channel.postMessage({ type: 'added', requestId: message.requestId,
            account: message.account, captureId } satisfies CapturePromotionMessage);
        } catch (cause) {
          if (disposed) return;
          if (cause instanceof PromotionInspectionRequired) {
            channel.postMessage({ type: 'inspection-required', requestId: message.requestId,
              account: message.account, captureId: null } satisfies CapturePromotionMessage);
            return;
          }
          error = cause instanceof Error ? cause.message : 'Could not save the promoted text.';
        }
      })();
    };
    return () => { disposed = true; channel.close(); };
  });

  function refreshDeletion() {
    if (!deletion) return;
    try {
      const current = previewCaptureDeletion(data, deletion.captureId);
      if (JSON.stringify(current) !== JSON.stringify(deletion)) {
        deletion = current;
        previewChanged = true;
      }
    } catch (cause) {
      deletion = null;
      error = cause instanceof Error ? cause.message : 'Could not review this capture.';
    }
  }

  $effect(() => {
    if (!deletion) return;
    view;
    refreshDeletion();
    const bodies = [data.tables.captures.body(deletion.captureId),
      ...deletion.thoughts.map((thought) => data.tables.thoughts.body(thought.id))];
    const stops = bodies.map((item, index) => item
      ? (index === 0 ? data.tables.captures : data.tables.thoughts).watch(item, refreshDeletion)
      : () => {});
    return () => stops.forEach((stop) => stop());
  });

  function reviewDeletion() {
    if (!selected) return;
    try {
      deletion = previewCaptureDeletion(data, selected.id);
      previewChanged = false;
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not review this capture.';
    }
  }

  async function confirmDeletion() {
    if (!deletion || previewChanged || deleting) return;
    const confirmed = deletion;
    deleting = true;
    try {
      await deleteConfirmedCapture(store, confirmed);
      deletion = null;
      error = '';
      open(null);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save the deletion.';
      if (data.tables.captures.get(confirmed.captureId)) refreshDeletion();
      else open(null);
    } finally { deleting = false; }
  }
</script>

<header class="border-b border-border/70">
  <div class="mx-auto flex h-16 max-w-3xl items-center justify-between gap-4 px-5 sm:px-8">
    <Button variant="ghost" size="sm" class="-ml-3 min-h-10 text-base font-semibold tracking-tight" onclick={() => open(null)}>Capture</Button>
    <div class="flex items-center gap-3 sm:gap-5">
      <span role="status" class="text-xs text-muted-foreground">
        {saveStatus === 'saved' ? 'Saved on this device' : saveStatus === 'pending' ? 'Saving…' : 'Save blocked'}
      </span>
      <AccountPopover {auth} syncNoun="captures" />
    </div>
  </div>
</header>
<main class="mx-auto w-full max-w-3xl px-5 pb-20 pt-9 sm:px-8 sm:pt-14">
  {#if data.tables.captures.nonconforming.length || data.tables.thoughts.nonconforming.length || data.tables.entries.nonconforming.length}
    <p role="alert" class="mb-5 rounded border border-destructive p-3 text-sm text-destructive">
      Some writing cannot be read by this version of Capture. No unreadable rows are deleted automatically.
    </p>
  {/if}
  <PersistenceNotice persistence={data.persistence} />
  {#if error}<p role="alert" class="mb-5 text-sm text-destructive">{error}</p>{/if}

  {#if selectedId && !selected}
    <p role="alert" class="mb-5">This capture is not available yet.</p>
    <Button variant="outline" size="sm" onclick={() => open(null)}>Back to timeline</Button>
  {:else if selected}
    <Button variant="ghost" size="sm" class="mb-9 -ml-3" onclick={() => open(null)}>← Timeline</Button>
    <div class="mb-7 flex items-start justify-between gap-3">
      <div>
        <h1 class="mb-2 text-3xl font-semibold tracking-tight">Capture</h1>
        <time class="block text-sm text-muted-foreground" datetime={selected.capturedAt}>
          {new Date(selected.capturedAt).toLocaleString()}
        </time>
      </div>
      <Button variant="outline" size="sm" class="min-h-10 shrink-0 text-destructive" onclick={reviewDeletion}>Delete capture…</Button>
    </div>
    {#if deletion}
      <section aria-label="Delete preview" class="mb-7 rounded-xl border border-destructive/50 bg-destructive/5 p-4 text-sm sm:p-5">
        <h2 class="text-base font-semibold">Permanently delete this capture and {deletion.thoughts.length} {deletion.thoughts.length === 1 ? 'thought' : 'thoughts'}?</h2>
        <p class="mt-2 text-muted-foreground">Thoughts added on another offline device after this review may survive in recovery.</p>
        <p class="mt-5 text-xs font-medium text-muted-foreground">Capture text</p>
        <p class="mt-1 whitespace-pre-wrap break-words">{deletion.text || 'Empty capture'}</p>
        {#if deletion.thoughts.length}<p class="mt-5 text-xs font-medium text-muted-foreground">Thoughts to delete</p>{/if}
        <ul class="mt-1 max-h-64 list-disc overflow-auto pl-5">
          {#each deletion.thoughts as thought (thought.id)}
            <li class="whitespace-pre-wrap break-words py-1">{thought.text || 'Empty thought'}</li>
          {/each}
        </ul>
        {#if previewChanged}<p role="status" class="mt-3">This capture changed. Review the updated list before deleting.</p>{/if}
        <div class="mt-5 flex flex-wrap gap-3">
          {#if previewChanged}
            <Button size="sm" variant="destructive" onclick={() => previewChanged = false}>I reviewed the changes</Button>
          {:else}
            <Button size="sm" variant="destructive" disabled={deleting} onclick={confirmDeletion}>
              {deleting ? 'Saving deletion…' : 'Permanently delete'}
            </Button>
          {/if}
          <Button size="sm" variant="outline" onclick={() => deletion = null}>Cancel</Button>
        </div>
      </section>
    {/if}
    {#if body}{#key selected.id}<TextEditor {body} label="Capture text" />{/key}{/if}
    <section class="mt-12 border-t border-border pt-8" aria-label="Capture thoughts">
      <h2 class="mb-6 text-xl font-semibold tracking-tight">Thoughts</h2>
      <form onsubmit={addThought} class="mb-7 flex flex-col gap-3 rounded-xl border border-border p-4 sm:p-5">
        <label for="new-thought" class="text-sm font-medium">Add a thought</label>
        <Textarea id="new-thought" bind:value={() => thoughtDraft, setThoughtDraft} rows={3} placeholder="Write a line or paragraph…" />
        <Button type="submit" size="sm" class="self-end">Add thought</Button>
      </form>
      {#if selectedThoughts.length}
        <ol aria-label="Thoughts" class="list-decimal border-t border-border pl-6 marker:text-sm marker:text-muted-foreground">
          {#each selectedThoughts as thought, index (thought.id)}
            <li class="pl-1">
              <ThoughtItem {store} {thought} captures={view.captures}
                canMoveUp={index > 0} canMoveDown={index < selectedThoughts.length - 1} />
            </li>
          {/each}
        </ol>
      {:else}
        <p class="border-t border-border py-5 text-sm text-muted-foreground">Thoughts you add will stay with this capture.</p>
      {/if}
    </section>
  {:else}
    <div class="mb-8 flex items-center justify-between gap-4">
      <h1 class="text-3xl font-semibold tracking-tight">Timeline</h1>
      <Dialog.Root bind:open={captureDialogOpen}>
        <Dialog.Trigger>
          {#snippet child({ props })}
            <Button {...props} size="sm" class="min-h-10">New capture</Button>
          {/snippet}
        </Dialog.Trigger>
        <Dialog.Content class="sm:max-w-xl">
          <Dialog.Header>
            <Dialog.Title>New capture</Dialog.Title>
            <Dialog.Description>Write or paste something to keep. You can edit it after adding the capture.</Dialog.Description>
          </Dialog.Header>
          <form onsubmit={addCapture} class="flex flex-col gap-4">
            <label for="new-capture" class="text-sm font-medium">Capture text</label>
            <Textarea id="new-capture" bind:value={captureDraft} rows={8} class="min-h-40 resize-y" placeholder="Write or paste something…" />
            {#if captureError}<p role="alert" class="text-sm text-destructive">{captureError}</p>{/if}
            <Dialog.Footer class="gap-2">
              <Button type="button" variant="outline" onclick={() => captureDialogOpen = false}>Cancel</Button>
              <Button type="submit">Add capture</Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </div>
    <div aria-label="Timeline captures" class="space-y-3">
      {#each view.captures as capture (capture.id)}
        <CaptureRow {store} {capture} {open} thoughtCount={view.thoughts.get(capture.id)?.length ?? 0} />
      {:else}
        <p class="py-7 text-sm text-muted-foreground">Your captures will appear here. Start with New capture.</p>
      {/each}
    </div>
    {#if view.recovery.length}
      <section aria-label="Thought recovery" class="mt-10">
        <Card.Root class="flex-row items-center justify-between gap-4 p-4 sm:p-5">
          <div>
            <h2 class="text-base font-semibold">{view.recovery.length} {view.recovery.length === 1 ? 'thought' : 'thoughts'} without a capture</h2>
            <p class="mt-1 text-sm text-muted-foreground">The capture {view.recovery.length === 1 ? 'it belongs' : 'they belong'} to is unavailable here.</p>
          </div>
          <Button variant="outline" size="sm" class="min-h-10 shrink-0" aria-expanded={recoveryExpanded} aria-controls="recovered-thoughts" onclick={() => recoveryExpanded = !recoveryExpanded}>
            {recoveryExpanded ? `Hide ${view.recovery.length === 1 ? 'thought' : 'thoughts'}` : `Review ${view.recovery.length === 1 ? 'thought' : 'thoughts'}`}
          </Button>
        </Card.Root>
        <div id="recovered-thoughts" hidden={!recoveryExpanded} class="mt-4 border-t border-border">
          {#each view.recovery as thought (thought.id)}
            <ThoughtItem {store} {thought} captures={view.captures} />
          {/each}
        </div>
      </section>
    {/if}
    {#if data.tables.entries.rows.length}
      <section aria-label="Earlier entries" class="mt-12 border-t border-border pt-8">
        <h2 class="text-xl font-semibold tracking-tight">Earlier entries</h2>
        <p class="mt-1 text-sm text-muted-foreground">Writing from the earlier Capture format stays here. Copy text you want to bring into a new capture or thought.</p>
        {#each [...data.tables.entries.rows].sort((a, b) => a.capturedAt === b.capturedAt ? (a.id < b.id ? -1 : 1) : a.capturedAt > b.capturedAt ? -1 : 1) as entry (entry.id)}
          <LegacyEntry {store} {entry} />
        {/each}
      </section>
    {/if}
  {/if}
</main>
