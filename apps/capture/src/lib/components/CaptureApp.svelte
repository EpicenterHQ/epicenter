<!--
	Capture over the folder's captures (`$lib/app`), in either build: a
	header with where they are and what can be done about it (the build's
	`Chrome`: the account on the web, the folder on the desktop), then the
	timeline or the one open capture.
-->
<script lang="ts">
	import Chrome from '#platform/chrome';
	import { Button } from '@epicenter/ui/button';
	import { folder } from '$lib/app.js';
	import { createCaptures } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	const captures = createCaptures(folder.captures);

	/** One page: the timeline or the one open capture. */
	const item = $derived(captures.opened);
</script>

<header class="border-b">
	<div class="mx-auto flex h-12 max-w-3xl items-center gap-2 px-4 sm:px-6">
		<Button variant="ghost" size="sm" class="-ml-2.5" onclick={() => captures.leave()}>Capture</Button>
		<Chrome />
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
	<div>
		{#if item === undefined}
			<Timeline {captures} />
		{:else if item.mode === 'capture'}
			{#key item}
				<CaptureDetail {captures} id={item.id} />
			{/key}
		{:else}
			{#key item}
				<TextDetail {captures} id={item.id} />
			{/key}
		{/if}
	</div>
</main>
