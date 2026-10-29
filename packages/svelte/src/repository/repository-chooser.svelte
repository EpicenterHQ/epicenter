<!--
	Which of this browser's repositories an app shows. The repositories are
	the browser's replicas: each one lists with its name and where it syncs,
	and opens, or is removed from this browser. A new one is kept only on
	this device, or syncs with a server given its address, the repository's
	name there, and whom to sync as. The repository last opened opens again
	on the next visit, so a reload shows the app directly.

	An open repository is one handle for as long as it is chosen, under the
	repository gate; the app gets `leave` to come back here, which closes it
	and lists any typing it could not save, to copy.

	The development server (`packages/repository/scripts/serve.ts`) takes
	whom to sync as from `Authorization: Bearer <name>`; that is the
	credential sent until repositories have accounts of their own.

	```svelte
	<RepositoryChooser app={todosApp} name="Todos">
		{#snippet children({ repo, manifest, leave })}
			<TodosApp {repo} syncsTo={manifest.url} onLeave={leave} />
		{/snippet}
	</RepositoryChooser>
	```
-->
<script lang="ts" generics="TDefs extends Definitions">
	import type { App, Definitions, Repository, Unsaved } from '@epicenter/repository';
	import {
		createBrowserRepository,
		listBrowserRepositories,
		type Manifest,
		openBrowserRepository,
		removeBrowserRepository,
	} from '@epicenter/repository/browser';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy, type Snippet, tick } from 'svelte';
	import { reactive } from './index.js';
	import RepositoryGate from './repository-gate.svelte';

	let {
		app,
		name,
		children,
	}: {
		app: App<TDefs>;
		/** The app's name, as the person knows it; it also keys which repository opens again. */
		name: string;
		children: Snippet<[{ repo: Repository<TDefs>; manifest: Manifest; leave: () => void }]>;
	} = $props();

	// svelte-ignore state_referenced_locally
	const remembered = `epicenter:${name}:repository`;
	/** What a server takes as whom a request is from. */
	const headersOf = (manifest: Pick<Manifest, 'account' | 'url'>): Record<string, string> =>
		manifest.url === null || manifest.account === null ? {} : { authorization: `Bearer ${manifest.account}` };

	let listed = $state.raw<Manifest[]>();
	let chosen = $state.raw<{ repo: Repository<TDefs>; manifest: Manifest }>();
	/** Typing a repository closed without saving, for the person to copy. */
	let unsaved = $state.raw<{ name: string; drafts: Unsaved[] }>();
	let failure = $state<string>();
	let busy = $state(false);
	/** A removal waiting for the person to confirm it, and what it would lose. */
	let removing = $state.raw<{ manifest: Manifest; lost?: string }>();

	let form = $state({ name: '', url: '', repository: '', account: '' });

	async function list() {
		listed = (await listBrowserRepositories()).toSorted((a, b) => a.name.localeCompare(b.name));
		return listed;
	}

	function open(manifest: Manifest) {
		failure = undefined;
		unsaved = undefined;
		chosen = { manifest, repo: reactive(openBrowserRepository({ app, replica: manifest.replica, headers: headersOf(manifest) })) };
		localStorage.setItem(remembered, manifest.replica);
	}

	async function leave() {
		const left = chosen;
		if (left === undefined) return;
		localStorage.removeItem(remembered);
		chosen = undefined;
		// The app's views close their editors as they go; then the repository closes.
		await tick();
		const drafts = left.repo.close();
		if (drafts.length > 0) unsaved = { name: left.manifest.name, drafts };
		await list();
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		const url = form.url.trim();
		const synced = url !== '';
		const repository = synced ? form.repository.trim() : crypto.randomUUID();
		const account = synced ? form.account.trim() : null;
		const shown = form.name.trim() || name;
		busy = true;
		failure = undefined;
		const created = await createBrowserRepository({ app, repository, name: shown, account, url: synced ? url : null, headers: headersOf({ account, url: synced ? url : null }) });
		busy = false;
		if (created.error !== null) {
			failure = created.error.message;
			return;
		}
		const { manifest } = created.data;
		form = { name: '', url: '', repository: '', account: '' };
		unsaved = undefined;
		chosen = { manifest, repo: reactive(created.data.repository) };
		localStorage.setItem(remembered, manifest.replica);
	}

	async function remove(manifest: Manifest, discardUnsent: boolean) {
		busy = true;
		const removed = await removeBrowserRepository({ replica: manifest.replica, discardUnsent });
		busy = false;
		if (removed.error === null) removing = undefined;
		else if (removed.error.name === 'UnsentWork')
			removing = { manifest, lost: `${removed.error.paths.length} file(s) are only in this browser, and removing deletes them.` };
		else {
			removing = undefined;
			failure = removed.error.message;
		}
		await list();
	}

	void list().then((found) => {
		const last = localStorage.getItem(remembered);
		const manifest = found.find((candidate) => candidate.replica === last);
		if (manifest !== undefined && chosen === undefined) open(manifest);
	});

	onDestroy(() => chosen?.repo.close());

	const where = (manifest: Manifest) => (manifest.url === null ? 'Only on this device' : `Synced with ${new URL(manifest.url).host} as ${manifest.account ?? 'a guest'}`);
</script>

{#if chosen !== undefined}
	{@const { repo, manifest } = chosen}
	{#key manifest.replica}
		<RepositoryGate {repo} {name}>
			{@render children({ repo, manifest, leave })}
		</RepositoryGate>
	{/key}
{:else if listed === undefined}
	<Loading class="h-dvh" label="Opening…" />
{:else}
	<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 p-6" aria-label="Repositories">
		<h1 class="text-lg font-semibold">{name}: choose a repository</h1>

		{#if unsaved !== undefined}
			<section class="space-y-2 rounded-md border border-destructive/50 p-3 text-sm" aria-label="Not saved">
				<p>Closing {unsaved.name} left typing that was not saved. Copy it to keep it.</p>
				<ul class="space-y-1">
					{#each unsaved.drafts as draft (draft.path)}
						{@const text = draft.draft}
						<li class="flex items-center gap-2">
							<code class="min-w-0 flex-1 truncate font-mono text-xs">{draft.path}</code>
							<Button size="sm" variant="outline" onclick={() => void navigator.clipboard.writeText(text)}>Copy text</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if listed.length > 0}
			<ul class="divide-y rounded-md border" aria-label="Repositories in this browser">
				{#each listed as manifest (manifest.replica)}
					<li class="flex flex-wrap items-center gap-2 p-3" data-replica={manifest.replica}>
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium">{manifest.name}</p>
							<p class="truncate text-xs text-muted-foreground">{where(manifest)}</p>
						</div>
						{#if removing?.manifest.replica === manifest.replica}
							{@const lost = removing.lost}
							<p class="w-full text-xs text-destructive" role="alert">{lost ?? `Remove ${manifest.name} from this browser?`}</p>
							<Button size="sm" variant="destructive" disabled={busy} onclick={() => void remove(manifest, lost !== undefined)}>{lost === undefined ? 'Remove' : 'Remove anyway'}</Button>
							<Button size="sm" variant="ghost" onclick={() => (removing = undefined)}>Keep</Button>
						{:else}
							<Button size="sm" onclick={() => open(manifest)}>Open</Button>
							<Button size="sm" variant="ghost" aria-label="Remove {manifest.name}" onclick={() => (removing = { manifest })}>Remove</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		<form class="space-y-3 rounded-md border p-3" aria-label="New repository" onsubmit={create}>
			<h2 class="text-sm font-medium">New repository</h2>
			<label class="block space-y-1 text-sm">
				<span>Name</span>
				<Input bind:value={form.name} placeholder={name} />
			</label>
			<label class="block space-y-1 text-sm">
				<span>Server <span class="text-muted-foreground">(optional; without one, it stays on this device)</span></span>
				<Input bind:value={form.url} type="url" placeholder="http://127.0.0.1:8787/" />
			</label>
			{#if form.url.trim() !== ''}
				<label class="block space-y-1 text-sm">
					<span>Repository on the server</span>
					<Input bind:value={form.repository} required />
				</label>
				<label class="block space-y-1 text-sm">
					<span>Sync as</span>
					<Input bind:value={form.account} required />
				</label>
			{/if}
			{#if failure !== undefined}
				<p class="text-sm text-destructive" role="alert">{failure}</p>
			{/if}
			<Button type="submit" disabled={busy}>Create</Button>
		</form>
	</main>
{/if}
