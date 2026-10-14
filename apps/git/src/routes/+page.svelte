<script lang="ts">
 import { onMount, tick } from 'svelte';
 import { SvelteSet } from 'svelte/reactivity';
 import { invoke, isTauri } from '@tauri-apps/api/core';
 import { Button } from '@epicenter/ui/button';
 import { Input } from '@epicenter/ui/input';
 import * as Alert from '@epicenter/ui/alert';
 import * as Item from '@epicenter/ui/item';
 import { Folder, FileText, ChevronDown, ChevronRight, GitBranch, GitCommitHorizontal } from '@lucide/svelte';
 import { visibleRows } from '@epicenter/folder/file-browser';
 import SyncReview from '@epicenter/svelte/sync-review';
 import { openWorkingCopy, type WorkingCopy } from '$lib/workspace.svelte';

 let workspace = $state.raw<WorkingCopy>();
 let copy = $state('a');
 let remote = $state('');
 let opening = $state(false);
 let initializing = $state(true);
 let message = $state('');
 let showGit = $state(true);
 let newPath = $state('');
 let showGuide = $state(false);
 let gitOutput = $state<HTMLDivElement>();
 let followOutput = $state(true);
 $effect(() => {
  const output = workspace?.output;
  const element = gitOutput;
  if (output === undefined || !element || !followOutput) return;
  void tick().then(() => {
   if (gitOutput === element) element.scrollTop = element.scrollHeight;
  });
 });
 const expanded = new SvelteSet<string>();
 const rows = $derived(workspace ? visibleRows(workspace.listing, expanded) : []);
 const sync = $derived(workspace?.snapshot.sync);
 const location = $derived(workspace?.folder.location);
 const desktop = isTauri();
 let alive = true;

 onMount(() => {
  void (async () => {
   try {
    if (desktop) {
     const info = await invoke<{ remote: string; copy: string }>('demo_info');
     remote = info.remote; copy = info.copy;
    } else {
     copy = new URL(locationHref()).searchParams.get('copy') === 'b' ? 'b' : 'a';
     const response = await fetch('/demo/session');
     if (!response.ok) throw new Error('The demo remote is unavailable. Enter a remote URL or leave it empty to work locally.');
     const session = await response.json();
     remote = new URL(session.browserRemotePath, locationHref()).href;
    }
   } catch (error) { message = error instanceof Error ? error.message : String(error); }
   finally { initializing = false; }
  })();
  return () => { alive = false; void workspace?.close().catch(() => {}); };
 });
 function locationHref() { return window.location.href; }
 async function act(work: () => Promise<unknown>) {
  message = '';
  try { await work(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
 }
 async function open() {
  opening = true; message = '';
  try {
   if (workspace) { await workspace.close(); workspace = undefined; }
   const next = await openWorkingCopy(copy, remote);
   if (!alive) { await next.close(); return; }
   workspace = next; followOutput = true;
   for (const directory of next.listing.directories) expanded.add(directory);
   if (next.listing.files[0]) await next.select(next.listing.files[0].path);
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { opening = false; }
 }
</script>

<svelte:head><title>Git lab · {copy.toUpperCase()}</title></svelte:head>
<!-- Nothing watches the copy's files: the page reads them again when its window gains focus and after each of its own actions. -->
<svelte:window onfocus={() => { void workspace?.refresh().catch((error) => { message = error instanceof Error ? error.message : String(error); }); }} onbeforeunload={(event) => { if (workspace?.dirty) { event.preventDefault(); event.returnValue = ''; } }} />

<div class="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
 <header class="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
  <GitBranch class="size-5" />
  <span class="font-semibold">Git lab</span>
  <span class="text-sm text-muted-foreground">{desktop ? 'Desktop' : 'Browser'} · Working copy {copy.toUpperCase()}</span>
  <div class="ml-auto flex gap-2">
   <Button size="sm" variant="ghost" onclick={() => { showGuide = !showGuide; }} aria-expanded={showGuide}>Demo guide</Button>
   <Button size="sm" variant="outline" onclick={() => { showGit = !showGit; }} aria-expanded={showGit}><GitCommitHorizontal class="size-4" />Git</Button>
  </div>
 </header>
 <form class="flex shrink-0 flex-wrap items-end gap-3 border-b px-4 py-3" onsubmit={(event) => { event.preventDefault(); void open(); }}>
  <label class="flex flex-col gap-1 text-xs text-muted-foreground">Working copy
   <select aria-label="Working copy" bind:value={copy} disabled={opening || workspace !== undefined} class="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"><option value="a">A</option><option value="b">B</option></select>
  </label>
  <label class="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">Remote URL · leave empty for local history
   <Input aria-label="Remote URL" bind:value={remote} disabled={opening || workspace !== undefined} placeholder="https://example.com/project.git" />
  </label>
  {#if workspace}
   <Button type="button" variant="outline" disabled={workspace.running || opening} onclick={() => act(async () => { await workspace?.close(); workspace = undefined; })}>Close working copy</Button>
  {:else}
   <Button type="submit" disabled={initializing || opening}>{opening ? 'Opening…' : 'Open working copy'}</Button>
  {/if}
 </form>
 {#if message}
  <Alert.Root variant="destructive" class="shrink-0"><Alert.Title>Could not complete the action</Alert.Title><Alert.Description>{message}</Alert.Description></Alert.Root>
 {/if}
 {#if showGuide}
  <section aria-label="Demo guide" class="shrink-0 space-y-2 border-b bg-muted/30 px-4 py-3 text-sm">
   <p>Open A and B on the same remote. Each keeps its own files. In a browser, use a second tab with <code>?copy=b</code>; the desktop app opens two windows, and a copy stays with the window that opened it until the app quits.</p>
   <p>Both start with <code>notes/color.txt</code> containing <code>color=blue</code>. In A, change it to red and press <strong>Sync</strong>: A commits what it saved, brings in the remote, and pushes.</p>
   <p>In B, press <strong>Sync</strong>: red arrives. Edits to different lines of a file combine on their own.</p>
   <p>For a conflict, change the same line in both copies, say green in B and yellow in A. Sync A first, then Sync B. B shows its version and the remote's side by side and writes nothing until you choose one, or type your own, and press <strong>Apply and sync</strong>. <strong>Cancel</strong> forgets the review; nothing changed. A can then Sync the result.</p>
   <p>While the review shows, the editor and the Git actions wait. Merge refuses a conflict and points to Sync; Fetch, Pull, and the rest still work.</p>
  </section>
 {/if}
 {#if workspace}
  <div class="flex min-h-0 flex-1 overflow-hidden">
   <aside class="flex w-64 shrink-0 flex-col overflow-hidden border-r" aria-label="Files">
    <div class="flex items-center justify-between border-b px-3 py-2"><span class="text-sm font-medium">Files</span><Button variant="ghost" size="xs" disabled={workspace.running} onclick={() => act(() => workspace!.refresh())}>Refresh</Button></div>
    <Item.Group class="min-h-0 flex-1 overflow-auto p-2">
     {#each rows as row (row.path)}
      <Item.Button size="sm" class={workspace.selected === row.path ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'} style={`padding-left: ${row.depth * 16 + 8}px`} aria-label={row.kind === 'directory' ? `Folder ${row.path}` : `Open ${row.path}`} aria-current={workspace.selected === row.path ? 'page' : undefined} aria-expanded={row.kind === 'directory' ? expanded.has(row.path) : undefined} onclick={() => {
       if (row.kind === 'directory') { if (expanded.has(row.path)) expanded.delete(row.path); else expanded.add(row.path); }
       else void act(() => workspace!.select(row.path));
      }}>
       {#if row.kind === 'directory'}{#if expanded.has(row.path)}<ChevronDown class="size-3" />{:else}<ChevronRight class="size-3" />{/if}<Folder class="size-4" />{:else}<FileText class="size-4" />{/if}
       <span class="truncate text-sm">{row.name}</span>
      </Item.Button>
     {:else}<p class="p-3 text-sm text-muted-foreground">No files yet. Create one below.</p>{/each}
    </Item.Group>
    <section class="max-h-60 overflow-auto border-t p-3 text-xs" aria-label="Changes">
     <p class="mb-2 font-medium">Staged / unstaged</p>
     {#each workspace.paths as path (path.path)}<p class="break-all font-mono"><span class="whitespace-pre">{path.index}{path.worktree}</span> {path.path}</p>{:else}<p class="text-muted-foreground">Working copy clean</p>{/each}
    </section>
   </aside>
   <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm">
     <span class="truncate font-mono">{workspace.selected || 'Select a file'}</span>
     <span class="ml-auto text-xs text-muted-foreground">{workspace.saveMessage}</span>
     <Button variant="ghost" size="xs" disabled={workspace.running || !workspace.dirty} onclick={() => act(() => workspace!.flush())}>Save</Button>
    </div>
    {#if workspace.syncAttempt}
     <!-- The review is modal: it replaces the editor and Git actions until it is applied or cancelled. -->
     <div class="min-h-0 flex-1 overflow-auto p-4">
      {#key workspace.syncAttempt.id}
       <SyncReview
        attempt={workspace.syncAttempt}
        pending={workspace.syncing}
        problems={workspace.syncProblems}
        onCancel={() => workspace!.cancelSync()}
        onApply={(attempt, choices) => void workspace!.applySync(attempt, choices)}
       />
      {/key}
     </div>
    {:else}
    {#if workspace.snapshot.pendingIncoming}
     <div role="status" class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm"><span>An incoming update stopped before it finished. Inspect your files, then recover it explicitly.</span><Button size="xs" variant="outline" disabled={workspace.running} onclick={() => workspace!.recover()}>Recover incoming update</Button></div>
    {/if}
    {#if workspace.dirty && !['Unsaved changes', 'Saving…'].includes(workspace.saveMessage)}
     <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm"><span>Your text is still here.</span><Button size="xs" variant="outline" onclick={() => act(() => workspace!.keepMyText())}>Replace saved file with my text</Button><Button size="xs" variant="outline" onclick={() => act(() => workspace!.useSavedText())}>Discard my edits and reload</Button></div>
    {/if}
    {#if workspace.editable}
     <textarea aria-label="File text" class="min-h-0 flex-1 resize-none bg-background p-4 font-mono text-sm leading-6 outline-none" spellcheck="false" value={workspace.buffer} disabled={workspace.locked} oninput={(event) => workspace!.input(event.currentTarget.value)}></textarea>
    {:else}<div class="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">{workspace.selected ? workspace.saveMessage : 'Select a file to edit its text.'}</div>{/if}
  {#if showGit}
   <section class="flex h-64 shrink-0 flex-col border-t" aria-label="Git">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground"><span>Files save immediately; versions are explicit</span><div class="ml-auto flex flex-wrap gap-2"><Button size="xs" variant="ghost" disabled={workspace.locked} onclick={() => workspace!.status()}>Status</Button><Button size="xs" variant="ghost" disabled={workspace.locked} onclick={() => workspace!.commit()}>Save version</Button><Button size="xs" variant="ghost" disabled={workspace.locked || !remote} onclick={() => workspace!.fetch()}>Fetch</Button><Button size="xs" variant="ghost" disabled={workspace.locked || !remote} onclick={() => workspace!.pull()}>Pull</Button><Button size="xs" variant="ghost" disabled={workspace.locked || !remote} onclick={() => workspace!.merge()}>Merge</Button><Button size="xs" variant="ghost" disabled={workspace.locked || !remote} onclick={() => workspace!.push()}>Push</Button><Button size="xs" disabled={workspace.locked || !remote} onclick={() => workspace!.sync()}>Sync</Button></div></div>
    <div role="textbox" aria-readonly="true" aria-multiline="true" tabindex="0" bind:this={gitOutput} onscroll={(event) => { const element = event.currentTarget; followOutput = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }} aria-label="Git output" class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-4 py-2 font-mono text-xs">{workspace.output}</div>
    <form class="flex shrink-0 items-center gap-2 border-t px-4 py-2" onsubmit={(event) => { event.preventDefault(); const path = newPath; newPath = ''; void act(() => workspace!.create(path)); }}><Input aria-label="New file path" class="flex-1 font-mono" spellcheck={false} autocorrect="off" autocapitalize="off" bind:value={newPath} disabled={workspace.locked} placeholder="notes/new.txt" /><Button size="sm" type="submit" disabled={workspace.locked || !newPath.trim()}>New file</Button></form>
   </section>
  {/if}
  {/if}
   </main>
  </div>
  <footer class="flex shrink-0 flex-wrap gap-x-4 border-t px-4 py-2 text-xs text-muted-foreground"><span>{workspace.snapshot.branch}</span>{#if !remote}<span>Local history</span>{:else if sync?.state === 'observed' && sync.value.remote !== undefined}<span>{sync.value.ahead} ahead · {sync.value.behind} behind last fetched head{sync.stale ? ' · needs refresh' : ''}</span>{:else}<span>Remote relationship unknown</span>{/if}<span class="ml-auto truncate">{location?.kind === 'directory' ? location.root : location?.directory}</span></footer>
 {:else}
  <main class="flex flex-1 items-center justify-center p-8"><div class="max-w-lg space-y-3"><h1 class="text-xl font-semibold">Two working copies. One remote.</h1><p class="text-sm text-muted-foreground">Open a working copy to browse files and edit text. Sync brings the copies together and asks you before it writes a conflict. Save version, Fetch, Pull, Merge, and Push do one step each by hand. Opening an empty copy fetches the remote's main branch.</p><p class="text-sm text-muted-foreground">Copy A and copy B have separate files and history. Changes arrive only when you Sync or ask Git to bring them in.</p></div></main>
 {/if}
</div>
