<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { CAPTURE_PROMOTION_CHANNEL, PromotionInspectionRequired, captureView, createCapture, createPromotedCapture, createThought, deleteConfirmedCapture, previewCaptureDeletion, type CapturePromotionMessage } from '@epicenter/capture';
  import { InstantString } from '@epicenter/app/field';
  import type { Account } from '@epicenter/auth';
  import { fromData } from '@epicenter/svelte';
  import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
  import { AccountPopover } from '@epicenter/app-shell/account-popover';
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
  let drafts = $state<Record<string, string>>({});
  const draft = $derived(drafts[selectedId ?? ''] ?? '');
  function setDraft(value: string) { drafts[selectedId ?? ''] = value; }
  let error = $state('');
  let deletion = $state.raw<ReturnType<typeof previewCaptureDeletion> | null>(null);
  let previewChanged = $state(false);
  let deleting = $state(false);

  function open(id: string | null) {
    deletion = null;
    const url = new URL(location.href);
    if (id) url.searchParams.set('capture', id);
    else url.searchParams.delete('capture');
    return goto(url.pathname + url.search);
  }

  function add(event: SubmitEvent) {
    event.preventDefault();
    try {
      if (selected) createThought(data, selected.id, draft);
      else {
        const id = createCapture(data, draft).id;
        setDraft('');
        open(id);
      }
      setDraft('');
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this writing.';
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

<main class="mx-auto max-w-2xl px-5 py-8 sm:py-12">
  <header class="mb-8 flex items-center justify-between gap-3">
    <button type="button" class="text-xl font-semibold" onclick={() => open(null)}>Capture</button>
    <AccountPopover {auth} syncNoun="captures" />
  </header>
  {#if data.tables.captures.nonconforming.length || data.tables.thoughts.nonconforming.length || data.tables.entries.nonconforming.length}
    <p role="alert" class="mb-5 rounded border border-destructive p-3 text-sm text-destructive">
      Some writing cannot be read by this version of Capture. No unreadable rows are deleted automatically.
    </p>
  {/if}
  <PersistenceNotice persistence={data.persistence} />
  <p role="status" class="mb-5 text-xs text-muted-foreground">
    {saveStatus === 'saved' ? 'Saved on this device' : saveStatus === 'pending' ? 'Saving on this device…' : 'Save blocked'}
  </p>
  {#if error}<p role="alert" class="mb-5 text-sm text-destructive">{error}</p>{/if}

  {#if selectedId && !selected}
    <p role="alert" class="mb-5">This capture is not available yet.</p>
    <button type="button" class="underline" onclick={() => open(null)}>Back to timeline</button>
  {:else if selected}
    <button type="button" class="mb-6 text-sm underline" onclick={() => open(null)}>Timeline</button>
    <h1 class="mb-2 text-2xl font-semibold">Capture</h1>
    <time class="mb-5 block text-sm text-muted-foreground" datetime={selected.capturedAt}>
      {new Date(selected.capturedAt).toLocaleString()}
    </time>
    {#if body}{#key selected.id}<TextEditor {store} {body} kind="captures" label="Capture text" />{/key}{/if}
    <button type="button" class="mt-4 text-sm text-destructive underline" onclick={reviewDeletion}>Delete capture…</button>
    {#if deletion}
      <section aria-label="Delete preview" class="mt-5 rounded border border-destructive p-4 text-sm">
        <h2 class="font-semibold">Permanently delete this capture and {deletion.thoughts.length} {deletion.thoughts.length === 1 ? 'thought' : 'thoughts'}?</h2>
        <p class="mt-2 text-muted-foreground">Thoughts added on another offline device after this review may survive in recovery.</p>
        <p class="mt-3 whitespace-pre-wrap">{deletion.text || 'Empty capture'}</p>
        <ul class="mt-3 max-h-64 list-disc overflow-auto pl-5">
          {#each deletion.thoughts as thought (thought.id)}
            <li class="whitespace-pre-wrap py-1">{thought.text || 'Empty thought'}</li>
          {/each}
        </ul>
        {#if previewChanged}<p role="status" class="mt-3">This capture changed. Review the updated list before deleting.</p>{/if}
        <div class="mt-4 flex gap-4">
          {#if previewChanged}
            <button type="button" class="underline" onclick={() => previewChanged = false}>I reviewed the changes</button>
          {:else}
            <button type="button" disabled={deleting} class="text-destructive underline disabled:opacity-50" onclick={confirmDeletion}>
              {deleting ? 'Saving deletion…' : 'Permanently delete'}
            </button>
          {/if}
          <button type="button" class="underline" onclick={() => deletion = null}>Cancel</button>
        </div>
      </section>
    {/if}
    <h2 class="mb-2 mt-10 text-lg font-medium">Thoughts</h2>
    <form onsubmit={add} class="mb-5 flex flex-col gap-3">
      <label for="new-thought" class="text-sm font-medium">Add a thought</label>
      <textarea id="new-thought" bind:value={() => draft, setDraft} rows="3" placeholder="Write a line or paragraph…"
        class="w-full rounded-lg border border-border bg-transparent p-3 outline-none focus:border-foreground"></textarea>
      <button type="submit" class="self-end rounded-md bg-foreground px-4 py-2 text-sm text-background">Add thought</button>
    </form>
    {#if selectedThoughts.length === 0}<p class="py-4 text-sm text-muted-foreground">No thoughts yet.</p>{/if}
    <div aria-label="Thoughts">
      {#each selectedThoughts as thought (thought.id)}
        <ThoughtItem {store} {thought} captures={view.captures} onError={(message) => error = message} />
      {/each}
    </div>
  {:else}
    <h1 class="mb-2 text-2xl font-semibold">Timeline</h1>
    <p class="mb-7 text-sm text-muted-foreground">Recent captures first.</p>
    <form onsubmit={add} class="mb-7 flex flex-col gap-3">
      <label for="new-capture" class="text-sm font-medium">Add a capture</label>
      <textarea id="new-capture" bind:value={() => draft, setDraft} rows="3" placeholder="Write or paste something…"
        class="w-full rounded-lg border border-border bg-transparent p-3 outline-none focus:border-foreground"></textarea>
      <button type="submit" class="self-end rounded-md bg-foreground px-4 py-2 text-sm text-background">Add a capture</button>
    </form>
    {#if view.captures.length === 0}<p class="py-4 text-sm text-muted-foreground">No captures yet.</p>{/if}
    <div aria-label="Timeline captures">
      {#each view.captures as capture (capture.id)}<CaptureRow {store} {capture} {open} />{/each}
    </div>
    {#if view.recovery.length}
      <section aria-label="Thought recovery" class="mt-10">
        <h2 class="text-lg font-medium">Thoughts needing a capture</h2>
        <p class="mt-1 text-sm text-muted-foreground">Their capture is unavailable. You can edit, copy, move, or delete each thought.</p>
        {#each view.recovery as thought (thought.id)}
          <ThoughtItem {store} {thought} captures={view.captures} onError={(message) => error = message} />
        {/each}
      </section>
    {/if}
    {#if data.tables.entries.rows.length}
      <section aria-label="Earlier entries" class="mt-10">
        <h2 class="text-lg font-medium">Earlier entries</h2>
        <p class="mt-1 text-sm text-muted-foreground">Writing from the earlier Capture format stays here. Copy text you want to bring into a new capture or thought.</p>
        {#each [...data.tables.entries.rows].sort((a, b) => a.capturedAt === b.capturedAt ? (a.id < b.id ? -1 : 1) : a.capturedAt > b.capturedAt ? -1 : 1) as entry (entry.id)}
          <LegacyEntry {store} {entry} />
        {/each}
      </section>
    {/if}
  {/if}
</main>
