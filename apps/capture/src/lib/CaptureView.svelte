<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createEntry, deleteConfirmedSubtree, entryForest, moveEntry, previewDeletion } from '@epicenter/capture';
  import { fromData } from '@epicenter/svelte';
  import { PersistenceNotice } from '@epicenter/app-shell/persistence-notice';
  import { AccountPopover } from '@epicenter/app-shell/account-popover';
  import { auth } from './auth.svelte.js';
  import type { openCapture } from './open.js';
  import EntryEditor from './EntryEditor.svelte';
  import EntryRow from './EntryRow.svelte';

  let { store }: { store: Awaited<ReturnType<typeof openCapture>> } = $props();
  // This view mounts once under AppBoot's captured Account.
  // svelte-ignore state_referenced_locally
  const data = fromData(store);
  const forest = $derived(entryForest(data.tables.entries.rows));
  const selectedId = $derived(page.url.searchParams.get('entry'));
  const selected = $derived(selectedId ? forest.byId.get(selectedId) : undefined);
  const children = $derived(forest.children.get(selected?.id ?? null) ?? []);
  const body = $derived(selected ? data.tables.entries.body(selected.id) : undefined);
  const saveStatus = $derived(data.persistence.get());
  let draft = $state('');
  let error = $state('');
  let moving = $state(false);
  let destination = $state('');
  let deletion = $state.raw<ReturnType<typeof previewDeletion> | null>(null);
  let previewChanged = $state(false);
  let deleting = $state(false);

  function canMoveTo(id: string, target: string) {
    for (let current: string | null = target; current !== null; current = forest.parent.get(current) ?? null) {
      if (current === id) return false;
    }
    return true;
  }

  function move() {
    if (!selected) return;
    try {
      moveEntry(data, selected.id, destination || null);
      moving = false;
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not move this entry.';
    }
  }

  function refreshDeletion() {
    if (!deletion) return;
    try {
      const current = previewDeletion(data, deletion.rootId);
      if (JSON.stringify(current) !== JSON.stringify(deletion)) {
        deletion = current;
        previewChanged = true;
      }
    } catch (cause) {
      deletion = null;
      error = cause instanceof Error ? cause.message : 'Could not review this subtree.';
    }
  }

  $effect(() => {
    if (!deletion) return;
    forest;
    refreshDeletion();
    const stops = deletion.ids.map((id) => {
      const body = data.tables.entries.body(id);
      return body ? data.tables.entries.watch(body, refreshDeletion) : () => {};
    });
    return () => stops.forEach((stop) => stop());
  });

  function reviewDeletion() {
    if (!selected) return;
    try {
      deletion = previewDeletion(data, selected.id);
      previewChanged = false;
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not review this subtree.';
    }
  }

  async function confirmDeletion() {
    if (!deletion || previewChanged || deleting) return;
    const confirmed = deletion;
    deleting = true;
    try {
      await deleteConfirmedSubtree(store, confirmed);
      deletion = null;
      error = '';
      open(null);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save the deletion.';
      if (data.tables.entries.get(confirmed.rootId)) refreshDeletion();
      else open(null);
    } finally {
      deleting = false;
    }
  }

  function breadcrumbs(id: string) {
    const path: string[] = [];
    let parent = forest.parent.get(id) ?? null;
    while (parent !== null) {
      path.push(parent);
      parent = forest.parent.get(parent) ?? null;
    }
    return path.reverse();
  }

  function open(id: string | null) {
    deletion = null;
    moving = false;
    const url = new URL(location.href);
    if (id) url.searchParams.set('entry', id);
    else url.searchParams.delete('entry');
    void goto(url.pathname + url.search);
  }

  function add(event: SubmitEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    try {
      const made = createEntry(data, { parentId: selected?.id ?? null, text: draft });
      draft = '';
      error = '';
      open(made.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this entry.';
    }
  }
</script>

<main class="mx-auto max-w-2xl px-5 py-8 sm:py-12">
  <header class="mb-8 flex items-center justify-between gap-3">
    <button type="button" class="text-xl font-semibold" onclick={() => open(null)}>Capture</button>
    <AccountPopover {auth} syncNoun="entries" />
  </header>

  {#if data.tables.entries.nonconforming.length > 0}
    <p role="alert" class="mb-5 rounded border border-destructive p-3 text-sm text-destructive">
      {data.tables.entries.nonconforming.length} entries cannot be read by this version of Capture.
    </p>
  {/if}
  <PersistenceNotice persistence={data.persistence} />
  <p role="status" class="mb-5 text-xs text-muted-foreground">
    {saveStatus === 'saved' ? 'Saved on this device' : saveStatus === 'pending' ? 'Saving on this device…' : 'Save blocked'}
  </p>
  {#if error}<p role="alert" class="mb-5 text-sm text-destructive">{error}</p>{/if}

  {#if selectedId && !selected}
    <p role="alert" class="mb-5">This entry is not available yet.</p>
    <button type="button" class="underline" onclick={() => open(null)}>Back to timeline</button>
  {:else}
    {#if selected}
      <nav aria-label="Breadcrumb" class="mb-6 flex flex-wrap gap-2 text-sm text-muted-foreground">
        <button type="button" class="underline" onclick={() => open(null)}>Timeline</button>
        {#each breadcrumbs(selected.id) as ancestor}
          <span>/</span>
          <button type="button" class="max-w-32 truncate underline" onclick={() => open(ancestor)}>
            {data.tables.entries.body(ancestor)?.toString().trim().slice(0, 24) || 'Empty capture'}
          </button>
        {/each}
      </nav>
      <h1 class="mb-2 text-2xl font-semibold">Entry</h1>
      <time class="mb-5 block text-sm text-muted-foreground" datetime={selected.capturedAt}>
        {new Date(selected.capturedAt).toLocaleString()}
      </time>
      {#if body}
        {#key selected.id}<EntryEditor {store} {body} />{/key}
      {/if}
      {#if forest.suppressed.has(selected.id)}
        <p class="mt-3 text-sm text-muted-foreground">A conflicting move placed this entry in the timeline.</p>
      {/if}
      <div class="mt-5 flex flex-wrap gap-4 text-sm">
        <button type="button" class="underline" onclick={() => { moving = !moving; deletion = null; destination = forest.parent.get(selected.id) ?? ''; }}>Move</button>
        <button type="button" class="text-destructive underline" onclick={() => { moving = false; reviewDeletion(); }}>Delete entry…</button>
      </div>
      {#if moving}
        <div class="mt-4 flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1 text-sm">Move to
            <select aria-label="Move destination" bind:value={destination} class="rounded border border-border bg-background p-2">
              <option value="">Timeline</option>
              {#each [...forest.byId.values()].filter((entry) => canMoveTo(selected.id, entry.id)) as entry (entry.id)}
                <option value={entry.id}>{data.tables.entries.body(entry.id)?.toString().trim().slice(0, 60) || 'Empty capture'}</option>
              {/each}
            </select>
          </label>
          <button type="button" class="rounded bg-foreground px-3 py-2 text-background" onclick={move}>Move entry</button>
        </div>
      {/if}
      {#if deletion}
        <section aria-label="Delete preview" class="mt-5 rounded border border-destructive p-4 text-sm">
          <h2 class="font-semibold">Permanently delete {deletion.ids.length} {deletion.ids.length === 1 ? 'entry' : 'entries'}?</h2>
          <p class="mt-2 text-muted-foreground">These are the entries currently selected. Entries added or moved here on another device after confirmation can survive.</p>
          <ul class="mt-3 max-h-64 list-disc overflow-auto pl-5">
            {#each deletion.entries as entry (entry.id)}
              <li class="whitespace-pre-wrap py-1" style:margin-left={`${entry.depth * 0.75}rem`}>{entry.text || 'Empty capture'}</li>
            {/each}
          </ul>
          {#if previewChanged}
            <p role="status" class="mt-3">This subtree changed. Review the updated list before deleting.</p>
          {/if}
          <div class="mt-4 flex gap-4">
            {#if previewChanged}
              <button type="button" class="underline" onclick={() => previewChanged = false}>I reviewed the changes</button>
            {:else}
              <button type="button" disabled={deleting} class="text-destructive underline disabled:opacity-50" onclick={confirmDeletion}>{deleting ? 'Saving deletion…' : 'Permanently delete'}</button>
            {/if}
            <button type="button" class="underline" onclick={() => deletion = null}>Cancel</button>
          </div>
        </section>
      {/if}
      <h2 class="mb-2 mt-10 text-lg font-medium">Replies</h2>
    {:else}
      <h1 class="mb-2 text-2xl font-semibold">Timeline</h1>
      <p class="mb-7 text-sm text-muted-foreground">Recent entries first.</p>
    {/if}

    <form onsubmit={add} class="mb-7 flex flex-col gap-3">
      <label for="new-entry" class="text-sm font-medium">{selected ? 'Add a reply' : 'Capture a thought'}</label>
      <textarea id="new-entry" bind:value={draft} rows="3" placeholder="Write something…"
        class="w-full rounded-lg border border-border bg-transparent p-3 outline-none focus:border-foreground"></textarea>
      <button type="submit" disabled={!draft.trim()}
        class="self-end rounded-md bg-foreground px-4 py-2 text-sm text-background disabled:opacity-40">
        {selected ? 'Add reply' : 'Add entry'}
      </button>
    </form>

    {#if children.length === 0}
      <p class="py-8 text-sm text-muted-foreground">{selected ? 'No replies yet.' : 'No entries yet.'}</p>
    {:else}
      <div aria-label={selected ? 'Replies' : 'Timeline entries'}>
        {#each children as entry (entry.id)}
          <EntryRow {store} {entry} {open} />
        {/each}
      </div>
    {/if}
  {/if}
</main>
