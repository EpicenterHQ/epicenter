<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createQuery } from '@tanstack/svelte-query';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { groupByDay, matches } from '#lib/feed.ts';
	import { recordingsQueries, settingsQueries } from '#lib/queries.ts';
	import AddSampleButton from './AddSampleButton.svelte';
	import RecordButton from './RecordButton.svelte';
	import RecordingBar from './RecordingBar.svelte';
	import RecordingItem from './RecordingItem.svelte';

	/** How many rows render at a time; a person can have 15,000 recordings. */
	const PAGE = 100;

	const list = createQuery(() => recordingsQueries.list());
	const settings = createQuery(() => settingsQueries.read());
	const server = $derived(settings.data?.server);

	let search = $state('');
	let shown = $state(PAGE);

	/**
	 * Newest first. The list arrives oldest first; `filter` makes a new array,
	 * so reversing it in place is safe. (Not `toReversed`: it needs Safari 16,
	 * and the app supports macOS 10.15.)
	 */
	const found = $derived(
		(list.data ?? []).filter((recording) => matches(recording.transcript, search)).reverse(),
	);
	const openId = $derived(dictation.openId ?? list.data?.at(-1)?.id);
	const groups = $derived(groupByDay(found.slice(0, shown)));

	/** Show the next page once `node` comes within a screen of the bottom of the feed. */
	function loadMoreWhenSeen(node: HTMLElement) {
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) shown += PAGE;
			},
			{ root: node.closest('main'), rootMargin: '0px 0px 100% 0px' },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}
</script>

<div class="flex h-dvh flex-col">
	<header class="flex items-center gap-3 border-b px-4 py-2">
		<h1 class="text-base font-semibold">Whispering</h1>
		<span class="flex-1"></span>
		<IconButton label="Settings" variant="ghost" href="/settings">
			<SettingsIcon />
		</IconButton>
		{#if import.meta.env.DEV}<AddSampleButton />{/if}
		<RecordButton />
	</header>
	{#if dictation.status.kind !== 'idle'}
		<RecordingBar />
	{/if}

	<main class="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
		{#if !server}
			<Alert.Root>
				<Alert.Description>Add a transcription server to get text after each recording.</Alert.Description>
				<Alert.Action>
					<Button variant="outline" size="sm" href="/settings">Add server</Button>
				</Alert.Action>
			</Alert.Root>
		{/if}
		{#if list.isPending}
			<div class="flex flex-1 items-center justify-center"><Spinner /></div>
		{:else if list.isError}
			<p class="text-sm text-destructive">{list.error.message}</p>
		{:else if list.data.length === 0}
			<!-- With nothing recorded yet, recording is the one thing to do here. -->
			<div class="flex flex-1 flex-col items-center justify-center gap-4 pb-16 text-center">
				<button
					type="button"
					class="flex size-28 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 motion-reduce:transition-none"
					aria-label={dictation.status.kind === 'recording' ? 'Stop recording' : 'Start recording'}
					disabled={dictation.status.kind === 'starting' || dictation.status.kind === 'stopping'}
					onclick={() => dictation.toggle()}
				>
					{#if dictation.status.kind === 'recording'}
						<SquareIcon class="size-10 fill-current" />
					{:else}
						<MicIcon class="size-12" />
					{/if}
				</button>
				<p class="text-base font-medium">
					{dictation.status.kind === 'recording' ? 'Press again to stop' : 'Press to start talking'}
				</p>
				<p class="text-sm text-muted-foreground">
					Or press <kbd class="font-sans font-medium text-foreground">⌘⇧;</kbd> in any app.
					{server ? 'The text is copied when you stop.' : ''}
				</p>
			</div>
		{:else}
			<Input type="search" placeholder="Search transcripts" bind:value={search} />
			<p class="-mt-2 px-1 text-xs text-muted-foreground tabular-nums">
				{search.trim()
					? `${found.length.toLocaleString()} of ${list.data.length.toLocaleString()} match`
					: `${list.data.length.toLocaleString()} ${list.data.length === 1 ? 'recording' : 'recordings'}`}
			</p>

			{#each groups as group}
				<section class="flex flex-col gap-1">
					<h2 class="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{group.label}
					</h2>
					{#each group.items as recording (recording.id)}
						<RecordingItem
							{recording}
							open={recording.id === openId}
							onOpen={() => dictation.open(recording.id)}
						/>
					{/each}
				</section>
			{:else}
				<p class="px-4 text-sm text-muted-foreground">No transcript matches "{search}".</p>
			{/each}

			{#if found.length > shown}
				<!--
					Reaching this adds the next page. It is made again for each page,
					so a page too short to scroll past it still loads the next one.
				-->
				{#key shown}
					<div {@attach loadMoreWhenSeen} class="flex justify-center py-4"><Spinner /></div>
				{/key}
			{/if}
		{/if}
	</main>
</div>
