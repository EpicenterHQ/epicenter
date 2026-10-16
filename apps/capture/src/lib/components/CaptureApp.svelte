<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { beforeNavigate } from '$app/navigation';
	import type { Captures } from '$lib/captures.svelte.js';
	import { backToTimeline, openItem } from '$lib/item-actions.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import Recovery from './Recovery.svelte';
	import TechnicalDetails from './TechnicalDetails.svelte';
	import TextDetail from './TextDetail.svelte';
	import Timeline from './Timeline.svelte';

	let { captures }: { captures: Captures } = $props();

	// One page: the timeline, the recovery screen, or the one open capture.
	const item = $derived(captures.opened);
	let recovering = $state(false);
	/** The capture just added from the timeline, so its view starts at Add a thought. */
	let created = $state<string>();

	// Leaving would lose something: unsaved or unadded text, or running work.
	const mustStay = $derived(captures.unsettled > 0);

	// Drafts live only in this page. Unloading it while they are held, by a
	// reload, a tab close, or a navigation out of the app, raises the browser's
	// own "Leave site?". Closing the desktop window waits for the page's close.
	beforeNavigate((navigation) => {
		if (navigation.willUnload && mustStay) navigation.cancel();
	});


	const commitProblem = $derived.by(() => {
		const last = captures.git.lastCommit;
		if (last === undefined) return undefined;
		if (last.status === 'failed') return last.error;
		if (last.status === 'blocked') return last.reason;
		if (last.status === 'branchMoved') return 'The branch moved while committing.';
		return undefined;
	});
	let committing = $state(false);
	async function retryCommit() {
		committing = true;
		try {
			const outcome = await captures.commit();
			if (outcome.status === 'committed' || outcome.status === 'unchanged')
				toast.success('History is up to date');
			// No answer came back, so the snapshot cannot say what happened.
			else if (outcome.status === 'unconfirmed')
				toast.warning('The commit was not confirmed', { description: outcome.error });
			// Refused while Capture closes or Epicenter quits; the snapshot is unchanged.
			else if (outcome.status === 'blocked')
				toast.error('The commit did not start', { description: outcome.reason });
		} finally {
			committing = false;
		}
	}

	const status = $derived.by((): { text: string; tone: 'quiet' | 'pending' | 'problem' } => {
		if (captures.folderStopped) return { text: 'Saving unavailable', tone: 'problem' };
		const save = item?.kind === 'capture' || item?.kind === 'text' ? item.session.state : undefined;
		if (save?.status === 'error') return { text: 'Not saved', tone: 'problem' };
		if (save?.status === 'saving') return { text: 'Saving…', tone: 'quiet' };
		if (captures.unsettled > 0) return { text: 'Not saved yet', tone: 'pending' };
		return { text: 'Saved', tone: 'quiet' };
	});
</script>

<!-- Returning to the app reads the folder again. -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'visible') void captures.check();
	}}
/>
<svelte:window
	onfocus={() => void captures.check()}
	onkeydown={(event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && mustStay) {
			// The leave prompt is the webview's to show or not; refusing the
			// shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: some text is not saved', {
				description: 'Finish, resolve, or copy it first, then reload.',
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
				void backToTimeline(captures);
			}}>Capture</Button
		>
		<span
			role="status"
			class={{
				'text-xs': true,
				'text-muted-foreground': status.tone === 'quiet',
				'font-medium': status.tone !== 'quiet',
				'text-destructive': status.tone === 'problem',
			}}
		>{status.text}</span>
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
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
	{#if captures.listProblem}
		<Alert.Root variant="destructive">
			<Alert.Title>The captures folder could not be read</Alert.Title>
			<Alert.Description>What is listed here may be out of date. Text you have typed in this window is still here.</Alert.Description>
			<div class="mt-2 text-foreground"><Button variant="outline" size="sm" onclick={() => captures.refresh()}>Check again</Button></div>
			<TechnicalDetails detail={captures.listProblem} />
		</Alert.Root>
	{/if}
	{#if commitProblem}
		<Alert.Root aria-label="History problem">
			<Alert.Title>History was not recorded</Alert.Title>
			<Alert.Description>Your captures are saved as files. Only the Git commit that records them did not complete, so the latest changes are not in history yet.</Alert.Description>
			<div class="mt-2"><Button variant="outline" size="sm" disabled={committing} onclick={retryCommit}>{committing ? 'Committing…' : 'Try the commit again'}</Button></div>
			<TechnicalDetails detail={commitProblem} />
		</Alert.Root>
	{/if}

	<div>
		{#if item === undefined}
			{#if recovering}
				<Recovery
					{captures}
					onOpen={(stem, mode) => {
						recovering = false;
						void openItem(captures, stem, mode);
					}}
				/>
			{:else}
				<Timeline
					{captures}
					onCreated={() => (created = captures.opened?.stem)}
					onRecover={() => (recovering = true)}
				/>
			{/if}
		{:else if item.kind === 'loading'}
			<Loading label="Opening…" />
		{:else if item.kind === 'failed'}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This capture could not be opened</Empty.Title>
					<Empty.Description>Nothing was changed. It may have been removed or renamed outside this window.</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<div class="flex flex-wrap justify-center gap-2">
						<Button variant="outline" size="sm" onclick={() => void captures.reload()}>Try again</Button>
						<Button variant="outline" size="sm" onclick={() => void backToTimeline(captures)}>Back to timeline</Button>
					</div>
					<TechnicalDetails detail={item.message} />
				</Empty.Content>
			</Empty.Root>
		{:else if item.kind === 'capture'}
			{#key item}
				<CaptureDetail {captures} {item} focusNewThought={created === item.stem} />
			{/key}
		{:else}
			{#key item}
				<TextDetail {captures} {item} />
			{/key}
		{/if}
	</div>
</main>
