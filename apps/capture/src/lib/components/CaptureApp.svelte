<!--
	Capture inside `<OpenFolder>`: builds the store over the opened
	folder, and shows the timeline or the one open capture under a
	header that shows when folder writes are in progress.

	The folder keeps no history and syncs nowhere yet: the header offers no
	Save version, Sync, or Connect.
-->
<script lang="ts">
	import { saveLine } from '@epicenter/svelte/status-line';
	import { setFolder } from '$lib/folder.js';
	import { Button } from '@epicenter/ui/button';
	import { type CaptureFolder, createCaptures } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let { folder }: { folder: CaptureFolder } = $props();

	// The opened folder stays fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	setFolder(folder);
	// svelte-ignore state_referenced_locally
	const captures = createCaptures(folder);

	// One page: the timeline or the one open capture.
	const item = $derived(captures.opened);
</script>

<header class="border-b">
	<div class="mx-auto flex h-12 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
		<Button
			variant="ghost"
			size="sm"
			class="-ml-2.5"
			onclick={() => captures.leave()}>Capture</Button
		>
		<span role="status" aria-label="Saving" class="text-xs text-muted-foreground"
			>{saveLine(folder.saving).label}</span
		>
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
	<div>
		{#if item === undefined}
			<Timeline {captures} />
		{:else if item.mode === 'capture'}
			{#key item}
				<CaptureDetail {captures} stem={item.stem} />
			{/key}
		{:else}
			{#key item}
				<TextDetail {captures} stem={item.stem} />
			{/key}
		{/if}
	</div>
</main>
