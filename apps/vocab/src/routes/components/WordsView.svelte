<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { reviewImport, STARTER_LIST } from '$lib/import.js';
	import type { Entry } from '$lib/data.js';
	import type { createEntriesState } from '$lib/entries.svelte.js';
	let { entries, onStart }: {
		entries: ReturnType<typeof createEntriesState>;
		onStart: (focus: { entryId: string; text: string }[]) => void;
	} = $props();
	const stages = ['new', 'recognized', 'understood', 'usable'] as const;
	const labels: Record<Entry['stage'], string> = { new: 'New', recognized: 'Recognize', understood: 'Understand', usable: 'Use' };
	let search = $state('');
	let stage = $state<'all' | Entry['stage']>('all');
	let single = $state('');
	let paste = $state('');
	let review = $state<ReturnType<typeof reviewImport> | null>(null);
	let selected = $state<string[]>([]);
	let focusIds = $state<string[]>([]);
	const selectedFocus = $derived(focusIds.map((id) => entries.entries.find((entry) => entry.id === id)).filter((entry): entry is Entry => !!entry));
	const shown = $derived(entries.entries.filter((entry) =>
		(stage === 'all' || entry.stage === stage) && entry.text.toLowerCase().includes(search.toLowerCase()),
	));
	function openReview(raw: string) {
		review = reviewImport(raw, new Set(entries.entries.map((entry) => entry.text)));
		selected = [...review.eligible];
	}
	function confirmImport() {
		for (const text of selected) entries.save(text);
		review = null;
	}
	function toggleFocus(id: string) {
		focusIds = focusIds.includes(id) ? focusIds.filter((value) => value !== id) : selectedFocus.length < 3 ? [...selectedFocus.map((entry) => entry.id), id] : focusIds;
	}
	function start() {
		const focus = selectedFocus.map(({ id, text }) => ({ entryId: id, text }));
		if (focus.length) { onStart(focus); focusIds = []; }
	}
</script>

<div class="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto px-4 py-6 md:px-8">
	<div>
		<h2 class="text-2xl font-semibold">Words</h2>
		<p class="text-sm text-muted-foreground">Save expressions, write your own notes, and choose up to three for a tutor-led chat.</p>
	</div>
	<div class="flex flex-wrap items-end gap-2">
		<form class="flex flex-1 gap-2" onsubmit={(event) => { event.preventDefault(); if (entries.save(single)) single = ''; }}>
			<Input aria-label="New expression" placeholder="Add an expression" bind:value={single} />
			<Button type="submit">Add</Button>
		</form>
		<Button variant="outline" onclick={() => openReview(STARTER_LIST)}>Browse starter list</Button>
	</div>
	<div class="space-y-2">
		<label class="text-sm font-medium" for="paste-expressions">Paste expressions, one per line</label>
		<Textarea id="paste-expressions" rows={3} bind:value={paste} placeholder="One expression per line" />
		<Button variant="outline" disabled={!paste.trim()} onclick={() => openReview(paste)}>Review paste</Button>
	</div>
	{#if review}
		<section class="space-y-3 rounded-lg border p-4" aria-label="Import review">
			<h3 class="font-semibold">Review expressions</h3>
			<p class="text-sm text-muted-foreground">{review.eligible.length} available; {review.repeated} repeated; {review.alreadySaved} already saved.</p>
			{#each review.eligible as text (text)}
				<label class="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selected.includes(text)} onchange={() => selected = selected.includes(text) ? selected.filter((item) => item !== text) : [...selected, text]} />{text}</label>
			{/each}
			<div class="flex gap-2"><Button disabled={!selected.length} onclick={confirmImport}>Add selected</Button><Button variant="ghost" onclick={() => review = null}>Cancel</Button></div>
		</section>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<Input aria-label="Search words" placeholder="Search words" class="max-w-xs" bind:value={search} />
		{#each ['all', ...stages] as option}
			<Button size="sm" variant={stage === option ? 'default' : 'outline'} onclick={() => stage = option as typeof stage}>{option === 'all' ? 'All' : labels[option as Entry['stage']]}</Button>
		{/each}
	</div>
	{#if entries.entries.length === 0}
		<p class="py-8 text-center text-muted-foreground">Your words will appear here. Add one above or browse the starter list.</p>
	{:else if shown.length === 0}
		<p class="py-8 text-center text-muted-foreground">No expressions match this search and stage.</p>
	{:else}
		<div class="space-y-3 pb-24">
			{#each shown as entry (entry.id)}
				<article class="rounded-lg border p-4">
					<div class="flex items-center justify-between gap-2">
						<label class="flex min-h-11 items-center gap-2 font-medium"><input type="checkbox" aria-label="Choose {entry.text} for chat" checked={focusIds.includes(entry.id)} disabled={!focusIds.includes(entry.id) && selectedFocus.length >= 3} onchange={() => toggleFocus(entry.id)} />{entry.text}</label>
						<Button size="sm" variant="ghost" onclick={() => entries.remove(entry.id)}>Delete</Button>
					</div>
					<textarea class="min-h-20 w-full rounded-md border bg-background p-2 text-sm" aria-label="Your note for {entry.text}" placeholder="Your note" value={entry.note} onblur={(event) => { if (event.currentTarget.value !== entry.note) entries.setNote(entry.id, event.currentTarget.value); }}></textarea>
					<div class="mt-2 flex flex-wrap gap-1" aria-label="Your stage for {entry.text}">
						{#each stages as option}<Button size="sm" variant={entry.stage === option ? 'default' : 'outline'} aria-pressed={entry.stage === option} onclick={() => entries.setStage(entry.id, option)}>{labels[option]}</Button>{/each}
					</div>
				</article>
			{/each}
		</div>
	{/if}
</div>
{#if selectedFocus.length}
	<div class="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-lg border bg-background p-2 shadow-lg"><Button onclick={start}>Start chat with {selectedFocus.length} {selectedFocus.length === 1 ? 'word' : 'words'}</Button></div>
{/if}
