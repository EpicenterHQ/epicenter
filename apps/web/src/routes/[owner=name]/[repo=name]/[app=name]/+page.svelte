<!--
	One first-party app over the open repository. Moving to another app of
	the same repository unmounts this one, closing its editors, and keeps the
	repository open.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { page } from '$app/state';
	import { appById } from '$lib/apps.js';
	import { addressOf } from '$lib/device.svelte.js';
	import { getOpenRepository } from '$lib/open.svelte.js';

	const { repo, manifest } = getOpenRepository();
	const address = addressOf(manifest);
	const entry = $derived(appById(page.params.app ?? ''));
</script>

<svelte:head><title>{entry === undefined ? manifest.name : `${entry.name} · ${manifest.name}`}</title></svelte:head>

{#if entry !== undefined}
	{@const Root = entry.Root}
	{#key entry.id}
		<Root {repo} repository={manifest.name} syncsTo={manifest.url ?? undefined} repositoryHref={address} />
	{/key}
{:else}
	<main class="mx-auto flex w-full max-w-lg flex-col gap-4 p-6">
		<p class="text-sm">There is no app named <code>{page.params.app}</code>.</p>
		<p><Button size="sm" variant="outline" href={address}>{manifest.name}'s apps</Button></p>
	</main>
{/if}
