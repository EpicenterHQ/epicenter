<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createQuery } from '@tanstack/svelte-query';
	import MicIcon from '@lucide/svelte/icons/mic';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { groupByDay, matches, type Sort, sortById } from '#lib/feed.ts';
	import { recordingsQueries } from '#lib/queries.ts';
	import RecordButton from './RecordButton.svelte';
	import RecordingItem from './RecordingItem.svelte';

	/** How many rows render at a time; a person can have 15,000 recordings. */
	const PAGE = 100;

	const list = createQuery(() => recordingsQueries.list());

	let search = $state('');
	let sort = $state<Sort>('newest');
	let shown = $state(PAGE);
	/** The recording the person opened; until they open one, the latest. */
	let opened = $state<string>();

	const found = $derived(
		sortById(
			(list.data ?? []).filter((recording) => matches(dictation.transcriptOf(recording), search)),
			sort,
		),
	);
	const openId = $derived(opened ?? dictation.latest ?? sortById(list.data ?? [], 'newest')[0]?.id);
	const groups = $derived(groupByDay(found.slice(0, shown), (recording) => recording.recordedAt));

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
		<RecordButton />
	</header>

	<main class="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
		{#if list.isPending}
			<div class="flex flex-1 items-center justify-center"><Spinner /></div>
		{:else if list.isError}
			<p class="text-sm text-destructive">{list.error.message}</p>
		{:else if list.data.length === 0}
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon"><MicIcon /></Empty.Media>
					<Empty.Title>No recordings yet</Empty.Title>
					<Empty.Description>Press Record and start talking.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<div class="flex gap-2">
				<Input type="search" placeholder="Search transcripts" bind:value={search} class="flex-1" />
				<Select.Root type="single" bind:value={sort}>
					<Select.Trigger class="w-36">{sort === 'newest' ? 'Newest first' : 'Oldest first'}</Select.Trigger>
					<Select.Content>
						<Select.Item value="newest">Newest first</Select.Item>
						<Select.Item value="oldest">Oldest first</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
			<p class="-mt-2 px-1 text-xs text-muted-foreground tabular-nums">
				{search.trim()
					? `${found.length.toLocaleString()} of ${list.data.length.toLocaleString()} match`
					: `${list.data.length.toLocaleString()} ${list.data.length === 1 ? 'recording' : 'recordings'}`}
			</p>

			{#each groups as group (group.label)}
				<section class="flex flex-col gap-1">
					<h2 class="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{group.label}
					</h2>
					{#each group.items as recording (recording.id)}
						<RecordingItem
							{recording}
							open={recording.id === openId}
							onOpen={() => (opened = recording.id)}
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
