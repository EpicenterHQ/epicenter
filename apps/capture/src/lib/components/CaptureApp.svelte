<script lang="ts">
	import type { Departure } from '@epicenter/epicenter/departure/page';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import { beforeNavigate } from '$app/navigation';
	import { createMutation } from '@tanstack/svelte-query';
	import type { CommitOutcome } from '@epicenter/folder';
	import { type Captures, describeError } from '$lib/captures.svelte.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import Recovery from './Recovery.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let {
		captures,
		departure,
	}: {
		captures: Captures;
		/** The host's question before it quits or restarts; none in a browser. */
		departure: Departure | undefined;
	} = $props();

	// One page: the timeline, the recovery screen, or the one open capture.
	const item = $derived(captures.opened);
	let recovering = $state(false);
	/** The capture just added from the timeline, so its view starts at Add a thought. */
	let created = $state<string>();

	// Leaving would lose something: a write or action still running, or text not added.
	const mustStay = $derived(captures.unsettled);

	// Text not added lives only in this page. A reload, a tab close, or a navigation out
	// of the app is held back here; quitting the desktop app asks below.
	beforeNavigate((navigation) => {
		if (mustStay && navigation.willUnload) navigation.cancel();
	});

	$effect(() => departure?.onHostStopped(() => captures.markServiceStopped()));

	/** Quitting or restarting, in the words the person chose. */
	const leaving = $derived(departure?.notice?.intent === 'restart' ? 'restart' : 'quit');
	/** The open question, while the person is asked. */
	const prompt = $derived(
		departure?.notice?.stage === 'choose' ? departure.notice : undefined,
	);

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

	const status = $derived.by((): { text: string; tone: 'quiet' | 'problem' } => {
		if (captures.folderStopped) return { text: 'Saving unavailable', tone: 'problem' };
		if (captures.saving) return { text: 'Saving…', tone: 'quiet' };
		return { text: 'Saved', tone: 'quiet' };
	});
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
			<span
				role="status"
				class={{
					'text-xs': true,
					'text-muted-foreground': status.tone === 'quiet',
					'font-medium': status.tone === 'problem',
					'text-destructive': status.tone === 'problem',
				}}
			>{status.text}</span>
			<Button
				variant="outline"
				size="sm"
				disabled={saveVersion.isPending || captures.fenced || captures.folderStopped}
				onclick={runSaveVersion}>{saveVersion.isPending ? 'Saving version…' : 'Save version'}</Button
			>
		</div>
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
	{#if departure?.notice && !prompt}
		<Alert.Root aria-label={leaving === 'restart' ? 'Restarting' : 'Quitting'}>
			<Alert.Title>{leaving === 'restart' ? 'Epicenter is restarting' : 'Epicenter is quitting'}</Alert.Title>
			<Alert.Description>
				{#if departure.notice.stage === 'keeping'}
					You chose to keep working. Your text is kept; editing resumes once Epicenter confirms it is staying open.
				{:else if departure.notice.stage === 'ready' || departure.notice.stage === 'leaving'}
					Waiting for Epicenter to {leaving}. Nothing here is changed or discarded unless it does.
				{:else}
					Saving what saves on its own. Editing is paused until Epicenter {leaving === 'restart' ? 'restarts' : 'quits'} or stays open.
				{/if}
			</Alert.Description>
			{#if departure.problem}
				<p role="status" class="mt-2 text-foreground">Epicenter did not receive this window's answer, so editing stays paused: {departure.problem}</p>
				<div class="mt-2"><Button variant="outline" size="sm" onclick={() => void departure.start()}>Check again</Button></div>
			{/if}
		</Alert.Root>
	{/if}
	{#if captures.folderStopped}
		<Alert.Root variant="destructive">
			<Alert.Title>Epicenter closed this folder</Alert.Title>
			<Alert.Description>Saving cannot be confirmed from this window. Your text is still here; copy or download it, then restart Epicenter. Reloading or quitting now discards it.</Alert.Description>
		</Alert.Root>
	{:else if captures.serviceStopped}
		<Alert.Root>
			<Alert.Title>Epicenter's background service stopped</Alert.Title>
			<Alert.Description>Captures still save to the folder from this window. Reloading it, or exporting captures from an account, may not work until Epicenter restarts.</Alert.Description>
		</Alert.Root>
	{/if}
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

{#if departure}
	<!-- One question per round. Closing it is Keep working. -->
	<Dialog.Root open={prompt !== undefined} onOpenChange={(open) => { if (!open && prompt) departure.keepWorking(prompt.id); }}>
		<Dialog.Content class="sm:max-w-md">
			{@const held = prompt?.held ?? 0}
			<Dialog.Header>
				<Dialog.Title>{held} {held === 1 ? 'thing is' : 'things are'} not saved</Dialog.Title>
				<Dialog.Description>
					{#if captures.folderStopped}
						Epicenter can no longer save from this window. {leaving === 'restart' ? 'Restarting' : 'Quitting'} now discards the text still open here. Keep working to copy or download it first.
					{:else}
						Some text was typed and not added yet. {leaving === 'restart' ? 'Restarting' : 'Quitting'} now discards it. Keep working to add or copy it.
					{/if}
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => prompt && departure.keepWorking(prompt.id)}>Keep working</Button>
				<Button variant="destructive" onclick={() => prompt && departure.leaveAnyway(prompt.id)}>{leaving === 'restart' ? 'Discard and restart' : 'Discard and quit'}</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
