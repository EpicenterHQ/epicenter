<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { beforeNavigate } from '$app/navigation';
	import { createMutation } from '@tanstack/svelte-query';
	import type { CommitOutcome } from '@epicenter/folder';
	import { type Captures, describeError } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import Recovery from './Recovery.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let { captures }: { captures: Captures } = $props();

	// One page: the timeline, the recovery screen, or the one open capture.
	const item = $derived(captures.opened);
	let recovering = $state(false);
	/** The capture just added from the timeline, so its view starts at Add a thought. */
	let created = $state<string>();

	// Leaving would lose something: a write or action still running, or text not added.
	const mustStay = $derived(captures.unsettled);

	// Text not added lives only in this page. A reload, a tab close, or a navigation out
	// of the app is held back here; quitting the desktop app asks nothing (ADR-0542).
	beforeNavigate((navigation) => {
		if (mustStay && navigation.willUnload) navigation.cancel();
	});

	/** Save version: commit the saved files. Capture has no remote, so nothing is pushed. */
	const saveVersion = createMutation(() => captures.saveVersion.options);
	function told(outcome: CommitOutcome) {
		switch (outcome.status) {
			case 'committed':
				return toast.success('Version saved', { description: outcome.indexWarning });
			case 'unchanged':
				return toast.info('No changes since the last version');
			case 'branchMoved':
				return toast.warning('Version not saved', {
					description: 'The history changed while saving. Your captures are saved; save the version again.',
				});
			case 'blocked':
				return toast.error('Version not saved', { description: outcome.reason });
			case 'failed':
				return toast.error('Version not saved', { description: outcome.error });
			case 'unconfirmed':
				return toast.warning('The version was not confirmed', { description: outcome.error });
			default:
				return toast.error('Version not saved');
		}
	}
	function runSaveVersion() {
		saveVersion.mutate(undefined, {
			onSuccess: told,
			onError: (error) => toast.error('Version not saved', { description: describeError(error) }),
		});
	}
</script>

<!-- Returning to the window reads the folder again: the query client listens for focus. -->
<svelte:window
	onbeforeunload={(event) => {
		if (mustStay) event.preventDefault();
	}}
	onkeydown={(event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && mustStay) {
			// The leave prompt is the webview's to show or not; refusing the
			// shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: some text is not saved', {
				description: 'Wait for saving to finish, and add or clear text you typed, then reload.',
			});
		}
	}}
/>

<header class="border-b">
	<div class="mx-auto flex h-12 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
		<Button
			variant="ghost"
			size="sm"
			class="-ml-2.5"
			onclick={() => {
				recovering = false;
				captures.leave();
			}}>Capture</Button
		>
		<div class="flex items-center gap-3">
			<span role="status" class="text-xs text-muted-foreground"
				>{captures.saving ? 'Saving…' : 'Saved'}</span
			>
			<Button
				variant="outline"
				size="sm"
				disabled={saveVersion.isPending || captures.fenced}
				onclick={runSaveVersion}>{saveVersion.isPending ? 'Saving version…' : 'Save version'}</Button
			>
		</div>
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
	<div>
		{#if item === undefined}
			{#if recovering}
				<Recovery
					{captures}
					onOpen={(stem, mode) => {
						recovering = false;
						captures.open(stem, mode);
					}}
				/>
			{:else}
				<Timeline
					{captures}
					onCreated={() => (created = captures.opened?.stem)}
					onRecover={() => (recovering = true)}
				/>
			{/if}
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
