<!--
	Storage: this browser's copies of repositories. Each lists with its
	address and where it syncs, and is removed from this browser here.
	Removing asks first, and says what would be lost: a file that has not
	reached a server is only in this browser. A new repository of yours is
	kept only on this device; joining makes this browser's copy of a synced
	one.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { addressOf, createLocal, isHome, type Manifest, remove, repositories, whereOf } from '$lib/device.svelte.js';
	import JoinForm from '$lib/JoinForm.svelte';
	import { onMount } from 'svelte';

	/** A removal waiting for the person to confirm it, and what it would lose. */
	let removing = $state.raw<{ manifest: Manifest; lost?: string }>();
	let failure = $state<string>();
	let busy = $state(false);
	let name = $state('');

	onMount(() => void repositories.refresh());

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

<svelte:head><title>Storage · Epicenter</title></svelte:head>

<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 p-6" aria-label="Storage">
	<header class="flex items-center gap-2">
		<h1 class="flex-1 text-lg font-semibold">This browser's repositories</h1>
		<Button size="sm" variant="ghost" href="/">Home</Button>
	</header>

	{#if failure !== undefined}
		<p class="text-sm text-destructive" role="alert">{failure}</p>
	{/if}

	{#if repositories.current === undefined}
		<Loading class="h-24" label="Listing…" />
	{:else if repositories.current.length === 0}
		<p class="text-sm text-muted-foreground">No repository is in this browser yet.</p>
	{:else}
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
		<h2 class="text-sm font-medium">New repository <span class="font-normal text-muted-foreground">(kept on this device)</span></h2>
		<label class="block space-y-1 text-sm">
			<span>Name</span>
			<Input bind:value={name} placeholder="Repository" />
		</label>
		<Button type="submit" disabled={busy}>Create</Button>
	</form>

	<JoinForm onJoined={(manifest) => void goto(addressOf(manifest))} />
</main>
