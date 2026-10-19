<!--
	Capture inside `<FolderApp>`: builds the store over the local
	folder's context, and shows the timeline or the one open capture under a
	header that says whether everything is saved in this browser.

	The folder keeps no history and syncs nowhere yet: the header offers no
	Save version, Sync, or Connect.
-->
<script lang="ts">
	import type { captureTables } from '@epicenter/capture';
	import { getFolder } from '@epicenter/svelte/folder';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { createCaptures } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	const captures = createCaptures(getFolder<typeof captureTables>());

	// One page: the timeline or the one open capture.
	const item = $derived(captures.opened);
	/** The capture just added from the timeline, so its view starts at Add a thought. */
	let created = $state<string>();

	// Leaving would lose something: a save running or held, or text not added.
	const mustStay = $derived(captures.unsettled);

	// Text not added lives only in this page. A reload, a tab close, or a
	// navigation out of the app is held back here.
	beforeNavigate((navigation) => {
		if (mustStay && navigation.willUnload) navigation.cancel();
	});

	// `<FolderApp>` sends the capture drafts when the page hides or goes
	// away; text typed with Edit as text is this page's to send.
	const sendTexts = () => void captures.texts.settle();
	onDestroy(sendTexts);
</script>

<svelte:window
	onpagehide={sendTexts}
	onbeforeunload={(event) => {
		if (mustStay) event.preventDefault();
	}}
	onkeydown={(event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && mustStay) {
			// The leave prompt is the browser's to show or not; refusing the
			// shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: some text is not saved', {
				description: 'Wait for saving to finish, and add or clear text you typed, then reload.',
			});
		}
	}}
/>
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') sendTexts();
	}}
/>

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
			<Timeline {captures} onCreated={() => (created = captures.opened?.stem)} />
		{:else if item.mode === 'capture'}
			{#key item}
				<CaptureDetail {captures} stem={item.stem} focusNewThought={created === item.stem} />
			{/key}
		{:else}
			{#key item}
				<TextDetail {captures} stem={item.stem} />
			{/key}
		{/if}
	</div>
</main>
