<!--
	`/<owner>/<repo>` and every app under it: the repository the address
	names, opened in this browser from the URL alone. `me` is you. The handle
	is the layout's, so moving between this repository's apps keeps it;
	another address opens that repository instead.

	Your home, `me/home`, is made here the first time it is used. A link
	`/<owner>/<repo>?server=<url>` joins a synced repository this
	browser has no copy of; once there is a copy, the address opens it and
	the link's `server` leaves the URL.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { addressOf, createHome, findAt, isHome, ownerOf, repositories } from '$lib/device.svelte.js';
	import JoinForm from '$lib/JoinForm.svelte';
	import Opened from '$lib/Opened.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const owner = $derived(ownerOf(page.params.owner ?? ''));
	const repository = $derived(page.params.repo ?? '');
	const server = $derived(page.url.searchParams.get('server'));
	const address = $derived(addressOf({ owner, repository }));
	const manifest = $derived(repositories.current === undefined ? undefined : findAt(repositories.current, owner, repository));

	/** The address this browser's copies were last listed for: a copy made since the last listing (another tab, a join) is found. */
	let listedFor = $state<string>();
	$effect(() => {
		const listing = address;
		void repositories.refresh().then(() => (listedFor = listing));
	});

	/** Why your home could not be made, when it could not. */
	let homeFailure = $state<string>();
	// Your home, `me/home`, is made the first time it is used.
	let making = false;
	$effect(() => {
		if (making || listedFor !== address || manifest !== undefined || !isHome({ owner, repository })) return;
		making = true;
		void createHome().then(({ error }) => {
			making = false;
			if (error !== null && error.name !== 'AlreadyHere') homeFailure = error.message;
		});
	});

	// A link that joined, or names a copy already here, opens it at its own address.
	$effect(() => {
		if (manifest === undefined || server === null) return;
		const url = new URL(page.url);
		url.searchParams.delete('server');
		void goto(url, { replaceState: true });
	});
</script>

{#if manifest !== undefined}
	{#key manifest.replica}
		<Opened {manifest}>{@render children()}</Opened>
	{/key}
{:else if listedFor !== address || (isHome({ owner, repository }) && homeFailure === undefined)}
	<Loading class="h-dvh" label="Opening…" />
{:else if homeFailure !== undefined}
	<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-4 p-6">
		<p class="text-sm text-destructive" role="alert">Could not make your home: {homeFailure}</p>
		<p><Button variant="outline" size="sm" href="/me">Your repositories and storage</Button></p>
	</main>
{:else}
	<main class="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 p-6" aria-label="Not in this browser">
		<h1 class="text-lg font-semibold"><code>{address}</code> is not in this browser</h1>
		<p class="text-sm text-muted-foreground">
			{server === null ? 'Join it from its server to make a copy here.' : 'Choose whom to sync as to make this browser\'s copy.'}
		</p>
		{#key address}
			<JoinForm owner={page.params.owner} {repository} server={server ?? ''} onJoined={() => void repositories.refresh()} />
		{/key}
		<p class="flex gap-2">
			<Button size="sm" variant="ghost" href="/me/home">Home</Button>
			<Button size="sm" variant="ghost" href="/me">Your repositories and storage</Button>
		</p>
	</main>
{/if}
