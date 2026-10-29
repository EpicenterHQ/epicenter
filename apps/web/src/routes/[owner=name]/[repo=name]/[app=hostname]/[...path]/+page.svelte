<!--
	An app on the open repository: `/<owner>/<repo>/<hostname>/<...path>`
	(ADR-0693). The app is the one installed at that hostname, mounted
	through its contract; its path is everything after the hostname, with
	the query. Moving to another app of the same repository unmounts this
	one, closing its editors, and keeps the repository open.

	A link naming an app that is not installed offers to install it, and to
	open the same path in Files instead.
-->
<script lang="ts">
	import { isAppPath } from '@epicenter/app';
	import { Button } from '@epicenter/ui/button';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppHost from '$lib/AppHost.svelte';
	import { FILES } from '$lib/catalog.js';
	import { addressOf } from '$lib/device.svelte.js';
	import { install, installedBundle } from '$lib/installed.svelte.js';
	import { getOpenRepository } from '$lib/open.svelte.js';
	import RepositoryBar from '$lib/RepositoryBar.svelte';

	const { repo, manifest } = getOpenRepository();
	const address = addressOf(manifest);
	const hostname = $derived(page.params.app ?? '');
	const bundle = $derived(installedBundle(hostname));
	const base = $derived(`${address}/${hostname}`);
	const path = $derived(`${page.url.pathname.slice(base.length) || '/'}${page.url.search}`);

	async function navigate(next: string, { replace = false }: { replace?: boolean } = {}) {
		if (!isAppPath(next)) throw new Error(`'${next}' is not an app path: it starts with one /`);
		await goto(`${base}${next}`, { replaceState: replace, keepFocus: true, noScroll: true });
	}

	let refusal = $state<string>();
	function installHere() {
		const installed = install(hostname);
		refusal = installed.error ?? undefined;
	}
</script>

<svelte:head><title>{bundle === undefined ? hostname : `${bundle.manifest.name} · ${manifest.name}`}</title></svelte:head>

{#if bundle !== undefined}
	<div class="flex h-full flex-col">
		<RepositoryBar {repo} {manifest} app={bundle.manifest.name} />
		<div class="min-h-0 flex-1">
			{#key bundle}
				<AppHost {bundle} {repo} {path} {navigate} />
			{/key}
		</div>
	</div>
{:else}
	<main class="mx-auto flex w-full max-w-lg flex-col gap-4 p-6" aria-label="App not installed">
		<h1 class="text-lg font-semibold"><code>{hostname}</code> is not installed</h1>
		<p class="text-sm text-muted-foreground">
			This link opens {manifest.name} in the app served at {hostname}. Installing an app trusts it with every repository in this browser.
		</p>
		{#if refusal !== undefined}
			<p class="text-sm text-destructive" role="alert">{refusal}</p>
		{/if}
		<p class="flex flex-wrap gap-2">
			<Button size="sm" onclick={installHere}>Install {hostname}</Button>
			{#if hostname !== FILES}
				<Button size="sm" variant="outline" href="{address}/{FILES}{path}">Open in Files</Button>
			{/if}
			<Button size="sm" variant="ghost" href={address}>{manifest.name}'s apps</Button>
		</p>
	</main>
{/if}
