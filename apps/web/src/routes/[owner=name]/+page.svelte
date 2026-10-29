<!--
	An owner's page (ADR-0693): their repositories in this browser. `/me` is
	you, so it also lists your installed apps, this browser's storage (every
	copy here, with Remove, a new repository, and joining a synced one), and
	your account, which is not built yet.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { addressOf, createLocal, HOME, isHome, type Manifest, ownerOf, remove, repositories, whereOf, YOU } from '$lib/device.svelte.js';
	import { installedApps } from '$lib/installed.svelte.js';
	import JoinForm from '$lib/JoinForm.svelte';

	const segment = $derived(page.params.owner ?? '');
	const owner = $derived(ownerOf(segment));
	const you = $derived(owner === null);
	const theirs = $derived((repositories.current ?? []).filter((manifest) => manifest.owner === owner));
	/** Your home is listed before it is made: opening it makes it. */
	const homeMissing = $derived(you && repositories.current !== undefined && !theirs.some(isHome));

	$effect(() => {
		void segment;
		void repositories.refresh();
	});

	/** A removal waiting for the person to confirm it, and what it would lose. */
	let removing = $state.raw<{ manifest: Manifest; lost?: string }>();
	let failure = $state<string>();
	let busy = $state(false);
	let name = $state('');

	async function removeCopy(manifest: Manifest, discardUnsent: boolean) {
		busy = true;
		failure = undefined;
		const removed = await remove(manifest, discardUnsent);
		busy = false;
		if (removed.error === null) removing = undefined;
		else if (removed.error.name === 'UnsentWork')
			removing = { manifest, lost: `${removed.error.paths.length} file(s) are only in this browser, and removing deletes them.` };
		else {
			removing = undefined;
			failure = removed.error.message;
		}
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failure = undefined;
		const created = await createLocal(name.trim() || 'Repository');
		busy = false;
		if (created.error !== null) failure = created.error.message;
		else await goto(addressOf(created.data));
	}
</script>

<svelte:head><title>{you ? 'You' : segment} · Epicenter</title></svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-8 p-6" aria-label="Owner">
	<header class="space-y-1">
		<h1 class="text-lg font-semibold">{you ? 'You' : segment}</h1>
		<p class="text-xs text-muted-foreground"><code>/{segment}</code>{you ? ' · the person using this browser' : ''}</p>
	</header>

	{#if failure !== undefined}
		<p class="text-sm text-destructive" role="alert">{failure}</p>
	{/if}

	<section class="space-y-2" aria-label="Repositories">
		<h2 class="text-sm font-medium">Repositories</h2>
		{#if repositories.current === undefined}
			<Loading class="h-16" label="Listing…" />
		{:else if theirs.length === 0 && !homeMissing}
			<p class="text-sm text-muted-foreground">No repository of {segment} is in this browser.</p>
		{:else}
			<ul class="divide-y rounded-md border" aria-label="Repositories of {segment}">
				{#if homeMissing}
					<li class="p-3"><a class="font-medium hover:underline" href="/{YOU}/{HOME}">Home (home)</a> <span class="text-xs text-muted-foreground">Made when first opened</span></li>
				{/if}
				{#each theirs as manifest (manifest.replica)}
					<li class="p-3">
						<a class="font-medium hover:underline" href={addressOf(manifest)}>{manifest.name}{isHome(manifest) ? ' (home)' : ''}</a>
						<span class="text-xs text-muted-foreground">{whereOf(manifest)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if you}
		<section class="space-y-2" aria-label="Installed apps">
			<h2 class="text-sm font-medium">Installed apps</h2>
			<ul class="divide-y rounded-md border" aria-label="Apps installed in this browser">
				{#each installedApps() as app (app.hostname)}
					<li class="flex flex-wrap items-center gap-2 p-3" data-app={app.hostname}>
						<span class="min-w-0 flex-1">
							<span class="block font-medium">{app.name}</span>
							<code class="block truncate text-xs text-muted-foreground">{app.hostname}</code>
							<code class="block truncate text-xs text-muted-foreground" title="The hash of the bundle installed" data-testid="app-hash">{app.hash.slice(0, 19)}…</code>
						</span>
						<Button size="sm" variant="ghost" href="/{YOU}/{HOME}/{app.hostname}">Open on Home</Button>
					</li>
				{/each}
			</ul>
		</section>

		<section class="space-y-3" aria-label="Storage">
			<h2 class="text-sm font-medium">Storage <span class="font-normal text-muted-foreground">(every copy in this browser)</span></h2>
			{#if repositories.current !== undefined && repositories.current.length > 0}
				<ul class="divide-y rounded-md border" aria-label="Copies in this browser">
					{#each repositories.current as manifest (manifest.replica)}
						<li class="flex flex-wrap items-center gap-2 p-3" data-replica={manifest.replica}>
							<div class="min-w-0 flex-1">
								<a class="block truncate font-medium hover:underline" href={addressOf(manifest)}>{manifest.name}{isHome(manifest) ? ' (home)' : ''}</a>
								<p class="truncate text-xs text-muted-foreground"><code>{addressOf(manifest)}</code> · {whereOf(manifest)}</p>
							</div>
							{#if removing?.manifest.replica === manifest.replica}
								{@const lost = removing.lost}
								<p class="w-full text-xs text-destructive" role="alert">{lost ?? `Remove ${manifest.name} from this browser?`}</p>
								<Button size="sm" variant="destructive" disabled={busy} onclick={() => void removeCopy(manifest, lost !== undefined)}>{lost === undefined ? 'Remove' : 'Remove anyway'}</Button>
								<Button size="sm" variant="ghost" onclick={() => (removing = undefined)}>Keep</Button>
							{:else}
								<Button size="sm" variant="ghost" aria-label="Remove {manifest.name}" onclick={() => (removing = { manifest })}>Remove</Button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<form class="space-y-3 rounded-md border p-3" aria-label="New repository" onsubmit={create}>
				<h3 class="text-sm font-medium">New repository <span class="font-normal text-muted-foreground">(kept on this device)</span></h3>
				<label class="block space-y-1 text-sm">
					<span>Name</span>
					<Input bind:value={name} placeholder="Repository" />
				</label>
				<Button type="submit" disabled={busy}>Create</Button>
			</form>

			<JoinForm onJoined={(manifest) => void goto(addressOf(manifest))} />
		</section>

		<section class="space-y-1" aria-label="Account">
			<h2 class="text-sm font-medium">Account</h2>
			<p class="text-sm text-muted-foreground">Accounts are not built yet. Until they are, <code>me</code> is the person using this browser, and your repositories and apps are kept here.</p>
		</section>
	{:else}
		<p><Button size="sm" variant="ghost" href="/{YOU}">You</Button></p>
	{/if}
</main>
