<!--
	A repository's page (ADR-0693): the installed apps that have data in it,
	plus Files, which shows any repository; the other installed apps, to
	start one here; where this copy syncs, with the link that joins it from
	another browser. Derived each time from the files: nothing records which
	apps a repository uses.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { page } from '$app/state';
	import { FILES } from '$lib/catalog.js';
	import { addressOf, joinLinkOf, whereOf, YOU } from '$lib/device.svelte.js';
	import { installedApps, installedBundle } from '$lib/installed.svelte.js';
	import { getOpenRepository } from '$lib/open.svelte.js';

	const { repo, manifest } = getOpenRepository();
	const address = addressOf(manifest);
	const ownerAddress = `/${manifest.owner ?? YOU}`;
	const link = $derived(joinLinkOf(manifest, page.url.origin));

	/** The installed apps with files in this repository, as of the last change; undefined until first counted. */
	let withData = $state.raw<ReadonlySet<string>>();
	$effect(() => {
		repo.revision();
		void Promise.all(
			installedApps().map(async ({ hostname }) => {
				for (const { name } of installedBundle(hostname)?.manifest.collections.lenses ?? []) {
					const found = await repo.query(`SELECT 1 FROM "${name}" LIMIT 1`);
					if (found.error === null && found.data.length > 0) return hostname;
				}
				return null;
			}),
		).then((hostnames) => (withData = new Set(hostnames.filter((hostname) => hostname !== null))));
	});

	const apps = $derived(installedApps().filter(({ hostname }) => hostname === FILES || withData?.has(hostname)));
	const others = $derived(withData === undefined ? [] : installedApps().filter(({ hostname }) => hostname !== FILES && !withData?.has(hostname)));
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
		{#each apps as app (app.hostname)}
			<li class="flex items-center gap-2 p-3" data-app={app.hostname}>
				<a class="min-w-0 flex-1 font-medium hover:underline" href="{address}/{app.hostname}">{app.name}</a>
				<code class="truncate text-xs text-muted-foreground">{app.hostname}</code>
			</li>
		{/each}
	</ul>

	{#if others.length > 0}
		<section class="space-y-2" aria-label="Other installed apps">
			<h2 class="text-sm font-medium">Start another app here <span class="font-normal text-muted-foreground">(no data here yet)</span></h2>
			<ul class="space-y-1 text-sm">
				{#each others as app (app.hostname)}
					<li data-app={app.hostname}><a class="hover:underline" href="{address}/{app.hostname}">{app.name}</a> <code class="text-xs text-muted-foreground">{app.hostname}</code></li>
				{/each}
			</ul>
		</section>
	{/if}

	<p class="flex gap-2">
		<Button size="sm" variant="ghost" href={ownerAddress}>{manifest.owner ?? 'Your'}{manifest.owner === null ? '' : "'s"} repositories</Button>
		{#if manifest.owner !== null}<Button size="sm" variant="ghost" href="/{YOU}">You</Button>{/if}
	</p>
</main>
