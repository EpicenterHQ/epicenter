<!--
	Recordings, read like mail: the list on the left, one recording on the
	right. The address names the open one (`?id=`), so Back and links work.
	Search shows the words around each match. "Needs attention" gathers the
	takes with no text, so recovering one is a click away; "Edited" the ones
	whose text differs from what the server wrote. ↑ and ↓ move through the
	list. In a narrow window the list fills it, and a row opens in its place.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import ListIcon from '@lucide/svelte/icons/list';
	import { createQuery } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { Recording } from '#lib/data/recordings.ts';
	import { groupByDay, matches } from '#lib/feed.ts';
	import { recordingsQueries } from '#lib/queries.ts';
	import RecordingRow from '../RecordingRow.svelte';
	import RecordingDetail from './RecordingDetail.svelte';
	import PageHeader from '../PageHeader.svelte';

	/** How many rows render at a time; a person can have 15,000 recordings. */
	const PAGE = 100;

	const FILTERS = {
		all: { label: 'All', keep: (_: Recording) => true },
		attention: { label: 'Needs attention', keep: (r: Recording) => !r.transcript },
		edited: { label: 'Edited', keep: (r: Recording) => r.original !== undefined },
	};
	type Filter = keyof typeof FILTERS;

	const list = createQuery(() => recordingsQueries.list());

	let search = $state('');
	let filter = $state<Filter>('all');
	let shown = $state(PAGE);

	/** Newest first; the list arrives oldest first, and `filter` makes a new array to reverse. */
	const found = $derived(
		(list.data ?? [])
			.filter((r) => FILTERS[filter].keep(r) && matches(r.transcript, search))
			.reverse(),
	);
	const groups = $derived(groupByDay(found.slice(0, shown)));
	const attention = $derived((list.data ?? []).filter(FILTERS.attention.keep).length);

	/** The id the address names; without one, a wide window shows the newest found. */
	const chosenId = $derived(page.url.searchParams.get('id'));
	const open = $derived(
		(chosenId ? list.data?.find((r) => r.id === chosenId) : undefined) ?? found[0],
	);

	function step(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
		event.preventDefault();
		const at = found.findIndex((r) => r.id === open?.id);
		const next = found[at + (event.key === 'ArrowDown' ? 1 : -1)];
		if (!next) return;
		void goto(`?id=${encodeURIComponent(next.id)}`, { replace: true, reset: false });
		document.querySelector(`[href$="id=${CSS.escape(encodeURIComponent(next.id))}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	/** Show the next page once `node` comes within a screen of the bottom of the list. */
	function loadMoreWhenSeen(node: HTMLElement) {
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) shown += PAGE;
			},
			{ root: node.closest('[data-list]'), rootMargin: '0px 0px 100% 0px' },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}
</script>

<svelte:head><title>Recordings · Whispering</title></svelte:head>
<svelte:window onkeydown={step} />

<div class="flex min-h-0 flex-1 flex-col">
	<div class="border-b px-6 pt-8 pb-5">
		<PageHeader title="Recordings" description="Everything you have dictated, kept on this device as files you can open." />
	</div>
	<div class="flex min-h-0 flex-1">
		<!-- The list: hidden in a narrow window while a recording is open there. -->
		<section
			class={cn(
				'flex min-h-0 w-full flex-col border-r md:w-96 md:shrink-0',
				chosenId && 'hidden md:flex',
			)}
			aria-label="Recordings"
		>
			<div class="flex flex-col gap-2 border-b p-3">
				<Input type="search" placeholder="Search transcripts" bind:value={search} oninput={() => (shown = PAGE)} />
				<div class="flex flex-wrap items-center gap-1">
					{#each Object.entries(FILTERS) as [key, { label }] (key)}
						<Button
							size="sm"
							variant={filter === key ? 'secondary' : 'ghost'}
							aria-pressed={filter === key}
							onclick={() => {
								filter = key as Filter;
								shown = PAGE;
							}}
						>
							{label}{key === 'attention' && attention ? ` ${attention}` : ''}
						</Button>
					{/each}
					<span class="ml-auto text-xs text-muted-foreground tabular-nums">
						{found.length.toLocaleString()}
					</span>
				</div>
			</div>

			<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2" data-list>
				{#if list.isPending}
					<div class="flex flex-1 items-center justify-center"><Spinner /></div>
				{:else if list.isError}
					<p class="p-2 text-sm text-destructive">{list.error.message}</p>
				{:else if list.data.length === 0}
					<Empty.Root>
						<Empty.Header>
							<Empty.Media variant="icon"><ListIcon /></Empty.Media>
							<Empty.Title>No recordings yet</Empty.Title>
							<Empty.Description>Record from <a href="/">Home</a>, or press ⌘⇧; in any app.</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					{#each groups as group (group.label)}
						<section class="flex flex-col">
							<h3 class="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
								{group.label}
							</h3>
							{#each group.items as recording (recording.id)}
								<RecordingRow {recording} query={search} selected={recording.id === open?.id} />
							{/each}
						</section>
					{:else}
						<p class="p-3 text-sm text-muted-foreground">
							{search.trim() ? `No transcript matches "${search}".` : `No recordings here.`}
						</p>
					{/each}
					{#if found.length > shown}
						{#key shown}
							<div {@attach loadMoreWhenSeen} class="flex justify-center py-4"><Spinner /></div>
						{/key}
					{/if}
				{/if}
			</div>
		</section>

		<!-- The reading pane: in a narrow window, only once a recording is chosen. -->
		<div class={cn('min-h-0 min-w-0 flex-1 flex-col', chosenId ? 'flex' : 'hidden md:flex')}>
			{#if open}
				{#key open.id}
					<RecordingDetail recording={open} />
				{/key}
			{:else if list.data?.length}
				<p class="m-auto text-sm text-muted-foreground">Choose a recording.</p>
			{/if}
		</div>
	</div>
</div>
