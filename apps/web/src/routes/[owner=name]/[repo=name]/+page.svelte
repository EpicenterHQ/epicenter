<!--
	A repository's page: every first-party app, each marked when the
	repository has files it claims; where this copy syncs, with the link that
	joins it from another browser; and this browser's other repositories.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { page } from '$app/state';
	import { apps } from '$lib/apps.js';
	import { addressOf, isHome, joinLinkOf, repositories, whereOf } from '$lib/device.svelte.js';
	import { getOpenRepository } from '$lib/open.svelte.js';

	const { repo, manifest } = getOpenRepository();
	const address = addressOf(manifest);
	const link = $derived(joinLinkOf(manifest, page.url.origin));

	/** The apps with files in this repository, as of the last change. */
	let withData = $state.raw<ReadonlySet<string>>(new Set());
	$effect(() => {
		repo.revision();
		void Promise.all(
			apps.map(async ({ id, app }) => {
				for (const { name } of app.lenses) {
					const found = await repo.query(`SELECT 1 FROM "${name}" LIMIT 1`);
					if (found.error === null && found.data.length > 0) return id;
				}
				return null;
			}),
		).then((ids) => (withData = new Set(ids.filter((id) => id !== null))));
	});

	const others = $derived((repositories.current ?? []).filter((other) => other.replica !== manifest.replica));
</script>

<svelte:head><title>{manifest.name} · Epicenter</title></svelte:head>

<main class="mx-auto flex h-full w-full max-w-lg flex-col gap-6 overflow-y-auto p-6" aria-label="Repository">
	<header class="space-y-1">
		<h1 class="text-lg font-semibold">{manifest.name}</h1>
		<p class="text-xs text-muted-foreground"><code>{address}</code> · {whereOf(manifest)}</p>
		{#if link !== null}
			<p class="flex items-center gap-2 text-xs">
				<span class="text-muted-foreground">Join from another browser:</span>
				<code class="min-w-0 flex-1 truncate" data-testid="join-link">{link}</code>
				<Button size="sm" variant="outline" onclick={() => void navigator.clipboard.writeText(link)}>Copy link</Button>
			</p>
		{/if}
	</header>

	<ul class="divide-y rounded-md border" aria-label="Apps">
		{#each apps as entry (entry.id)}
			<li class="flex items-center gap-2 p-3" data-app={entry.id}>
				<a class="min-w-0 flex-1 font-medium hover:underline" href="{address}/{entry.id}">{entry.name}</a>
				<span class="text-xs text-muted-foreground" data-testid="app-data">{withData.has(entry.id) ? 'Has data' : 'No data yet'}</span>
			</li>
		{/each}
	</ul>

	<section class="space-y-2" aria-label="Other repositories">
		<h2 class="text-sm font-medium">This browser's other repositories</h2>
		{#if others.length > 0}
			<ul class="space-y-1 text-sm">
				{#each others as other (other.replica)}
					<li><a class="hover:underline" href={addressOf(other)}>{other.name}{isHome(other) ? ' (home)' : ''}</a> <span class="text-xs text-muted-foreground">{whereOf(other)}</span></li>
				{/each}
			</ul>
		{/if}
		<p><Button size="sm" variant="ghost" href="/-/storage">Storage</Button></p>
	</section>
</main>
