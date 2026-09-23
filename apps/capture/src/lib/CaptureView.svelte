<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createEntry, entryForest } from '@epicenter/capture';
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
      {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
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
