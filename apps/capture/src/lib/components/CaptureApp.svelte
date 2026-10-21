<!--
	Capture inside `<FolderApp>`: builds the store over the local
	folder's context, and shows the timeline or the one open capture under a
	header that says whether everything is saved on this device.

	The folder keeps no history and syncs nowhere yet: the header offers no
	Save version, Sync, or Connect.
-->
<script lang="ts">
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import { type getFolder, setFolder } from '$lib/folder.js';
	import { Button } from '@epicenter/ui/button';
	import { beforeNavigate } from '$app/navigation';
	import { createCaptures } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let { context }: { context: ReturnType<typeof getFolder> } = $props();

	// The opened context stays fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
	// svelte-ignore state_referenced_locally
	const captures = createCaptures(context);

	// One page: the timeline or the one open capture.
	const item = $derived(captures.opened);

	// Read save status when leaving is requested, not while the view renders.
	beforeNavigate(({ willUnload, cancel }) => {
		if (!willUnload) return;
		const { saving, unsaved } = context.getStatus();
		if (saving || unsaved.length > 0) cancel();
	});
	// `<FolderApp>` sends what is typed, as fields or as text, when the page
	// hides or goes away.
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
			>{captures.saveLabel}</span
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
