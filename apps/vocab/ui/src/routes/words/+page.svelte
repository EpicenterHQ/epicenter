<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { langOf, matches, untilLabel } from '$lib/text.js';
	import { vocab } from '$lib/vocab.svelte.js';

	let search = $state('');

	/** Every word matching the search, the newest first. */
	const shown = $derived(
		vocab
			.words()
			.filter((word) => matches(word, search))
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
	);
	/** The time the words were last asked for, which their due labels count from. */
	const now = $derived.by(() => {
		vocab.refreshes();
		return new Date();
	});
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 p-4">
	<div class="flex items-baseline justify-between">
		<h1 class="text-2xl font-semibold">Words</h1>
		{#if vocab.words().length > 0}
			<p class="text-sm text-muted-foreground tabular-nums">{vocab.words().length}</p>
		{/if}
	</div>
	<Input type="search" aria-label="Search words" placeholder="Search by word, reading, or meaning" bind:value={search} />

	{#if !vocab.loaded()}
		<Loading class="flex-1" />
	{:else if vocab.problem()}
		<Alert.Root variant="destructive">
			<Alert.Title>Vocab could not reach your Epicenter</Alert.Title>
			<Alert.Description>{vocab.problem()}</Alert.Description>
		</Alert.Root>
	{:else if vocab.words().length === 0}
		<Empty.Root>
			<Empty.Header>
				<Empty.Title>No words yet</Empty.Title>
				<Empty.Description>The words you add show here.</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button href={resolve('/add')}>Add a word</Button></Empty.Content>
		</Empty.Root>
	{:else if shown.length === 0}
		<p class="py-8 text-center text-muted-foreground">No word matches “{search.trim()}”.</p>
	{:else}
		<ul class="-mx-2">
			{#each shown as word (word.word)}
				<li>
					<a
						href={resolve('/words/[word]', { word: word.word })}
						class="flex min-h-14 items-center gap-3 rounded-md px-2 py-2 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						<span lang={langOf(word.word)} class="shrink-0 text-xl">{word.word}</span>
						<span class="min-w-0 flex-1 truncate text-sm">
							{#if word.reading}<span class="text-muted-foreground">{word.reading}</span>{/if}
							{#if word.reading && word.meaning}<span class="text-muted-foreground"> · </span>{/if}
							{word.meaning ?? ''}
						</span>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							{#if word.due === undefined}
								New
							{:else if Date.parse(word.due) <= now.getTime()}
								Due
							{:else}
								{untilLabel(word.due, now)}
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
