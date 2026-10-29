<!--
	One app over the open repository, mounted through its contract: the
	app's path is everything after its segment, with the query. Moving to
	another app of the same repository unmounts this one, closing its
	editors, and keeps the repository open.
-->
<script lang="ts">
	import { isAppPath } from '@epicenter/app';
	import { Button } from '@epicenter/ui/button';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppHost from '$lib/AppHost.svelte';
	import { bundleFor } from '$lib/catalog.js';
	import { addressOf } from '$lib/device.svelte.js';
	import { getOpenRepository } from '$lib/open.svelte.js';
	import RepositoryBar from '$lib/RepositoryBar.svelte';

	const { repo, manifest } = getOpenRepository();
	const address = addressOf(manifest);
	/** Each first-party app's address segment. */
	const SEGMENTS: Record<string, string> = { todos: 'todos.epicenter.so', honeycrisp: 'honeycrisp.epicenter.so' };
	const segment = $derived(page.params.app ?? '');
	const bundle = $derived(bundleFor(SEGMENTS[segment] ?? ''));
	const base = $derived(`${address}/${segment}`);
	const path = $derived(`${page.url.pathname.slice(base.length) || '/'}${page.url.search}`);

	async function navigate(next: string, { replace = false }: { replace?: boolean } = {}) {
		if (!isAppPath(next)) throw new Error(`'${next}' is not an app path: it starts with one /`);
		await goto(`${base}${next}`, { replaceState: replace, keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>{bundle === undefined ? manifest.name : `${bundle.manifest.name} · ${manifest.name}`}</title></svelte:head>

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
	<main class="mx-auto flex w-full max-w-lg flex-col gap-4 p-6">
		<p class="text-sm">There is no app named <code>{segment}</code>.</p>
		<p><Button size="sm" variant="outline" href={address}>{manifest.name}'s apps</Button></p>
	</main>
{/if}
