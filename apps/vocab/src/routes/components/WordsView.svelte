<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { type Entry, type FocusItem, STAGE_LABELS, STAGES, type Stage } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { reviewImport, STARTER_LIST } from '$lib/import.js';
	import EntryCard from './EntryCard.svelte';
	import RepairCard from './RepairCard.svelte';
	let { entries, starting, onStart }: {
		entries: Entries;
		/** A chat is being saved; another cannot be started yet. */
		starting: boolean;
		/** Answers whether the chat started; the selection is kept when it did not. */
		onStart: (focus: FocusItem[]) => Promise<boolean>;
	} = $props();
	let search = $state('');
	let stage = $state<'all' | Stage>('all');
	let single = $state('');
	let adding = $state(false);
	let pasteOpen = $state(false);
	let paste = $state('');
	let review = $state<ReturnType<typeof reviewImport> | null>(null);
	let selected = $state<string[]>([]);
	let focusIds = $state<string[]>([]);
	const words = $derived(entries.words);
	const repairs = $derived(entries.repairs);

	const selectedFocus = $derived(focusIds.map((id) => words.find((entry) => entry.id === id)).filter((entry): entry is Entry => !!entry));
	const shown = $derived(words.filter((entry) =>
		(stage === 'all' || entry.stage === stage) && `${entry.text} ${entry.note}`.toLowerCase().includes(search.trim().toLowerCase()),
	));
	function openReview(raw: string) {
		review = reviewImport(raw, new Set(words.map((entry) => entry.text)));
		selected = [...review.eligible];
	}
	/** Save each addition, and clear the field or the review only for what the folder took. */
	async function add(texts: string[]): Promise<string[]> {
		adding = true;
		const failed: string[] = [];
		let taken = '';
		for (const text of texts) {
			const { error } = await entries.add(text);
			if (error !== null && error.name !== 'Empty') {
				failed.push(text);
				if (error.name === 'Taken') taken = error.message;
			}
		}
		adding = false;
		if (taken) toast.error('An expression was not added', { description: taken });
		return failed;
	}
	async function addSingle() {
		const submitted = single;
		if (!submitted.trim() || adding) return;
		const failed = await add([submitted]);
		if (failed.length === 0 && single === submitted) single = '';
	}
	async function confirmImport() {
		if (adding) return;
		const failed = await add(selected);
		// What was not saved stays selected for another try.
		if (failed.length === 0) review = null;
		else selected = failed;
	}
	function toggleFocus(id: string) {
		focusIds = focusIds.includes(id) ? focusIds.filter((value) => value !== id) : selectedFocus.length < 3 ? [...selectedFocus.map((entry) => entry.id), id] : focusIds;
	}
	async function start() {
		const focus = selectedFocus.map(({ id, text }) => ({ entryId: id, text }));
		if (focus.length && (await onStart(focus))) focusIds = [];
	}
</script>

<!-- The start action is the last row of this column, so it never covers a word or the page's bottom bar. -->
<div class="flex h-full flex-col">
	<div class="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 md:px-8">
		<div>
			<h2 class="text-2xl font-semibold">Words</h2>
			<p class="text-sm text-muted-foreground">Save expressions, write your own notes, and choose up to three for a tutor-led chat. Everything is saved in this browser; no sign-in is needed.</p>
		</div>
		<div class="flex flex-wrap items-end gap-2">
			<form class="flex min-w-0 basis-full gap-2 sm:flex-1 sm:basis-auto" onsubmit={(event) => { event.preventDefault(); void addSingle(); }}>
				<Input aria-label="New expression" placeholder="Add an expression" bind:value={single} />
				<Button type="submit" disabled={adding || !single.trim()}>Add</Button>
			</form>
			<Button variant="outline" aria-expanded={pasteOpen} aria-controls="paste-expressions-panel" onclick={() => pasteOpen = !pasteOpen}>Add multiple<ChevronDownIcon class="transition-transform group-aria-expanded/button:rotate-180" /></Button>
			<Button variant="outline" onclick={() => openReview(STARTER_LIST)}>Browse starter list</Button>
		</div>
		<!-- Hidden, not removed: closing it keeps the pasted text, and an open review stays below either way. -->
		<div id="paste-expressions-panel" class="space-y-2" hidden={!pasteOpen}>
			<label class="text-sm font-medium" for="paste-expressions">Paste expressions, one per line</label>
			<Textarea id="paste-expressions" rows={3} bind:value={paste} placeholder="One expression per line" />
			<Button variant="outline" disabled={!paste.trim()} onclick={() => openReview(paste)}>Review paste</Button>
		</div>
		{#if review}
			<section class="space-y-3 rounded-lg border p-4" aria-label="Import review">
				<h3 class="font-semibold">Review expressions</h3>
				<p class="text-sm text-muted-foreground">{review.eligible.length} available; {review.repeated} repeated; {review.alreadySaved} already saved.</p>
				{#each review.eligible as text (text)}
					<Label class="min-h-11 min-w-0 leading-normal font-normal select-text"><Checkbox checked={selected.includes(text)} onCheckedChange={(checked) => selected = checked ? [...selected, text] : selected.filter((item) => item !== text)} /><span class="min-w-0 flex-1 wrap-anywhere">{text}</span></Label>
				{/each}
				<div class="flex gap-2"><Button disabled={!selected.length || adding} onclick={confirmImport}>{adding ? 'Saving…' : 'Add selected'}</Button><Button variant="ghost" onclick={() => review = null}>Cancel</Button></div>
			</section>
		{/if}
		<div class="flex flex-wrap items-center gap-2">
			<Input aria-label="Search words" placeholder="Search expressions or notes" class="max-w-xs" bind:value={search} />
			{#each ['all', ...STAGES] as const as option}
				<Button size="sm" variant={stage === option ? 'default' : 'outline'} aria-pressed={stage === option} onclick={() => stage = option}>{option === 'all' ? 'All' : STAGE_LABELS[option]}</Button>
			{/each}
		</div>
		{#if entries.repair.open !== undefined}
			{#key entries.repair.open}<RepairCard {entries} id={entries.repair.open} />{/key}
		{/if}
		{#if repairs.length > 0}
			<section class="space-y-2 rounded-lg border p-3 text-xs" aria-label="Words that need repair">
				<p class="text-destructive">{repairs.length} saved {repairs.length === 1 ? 'file is' : 'files are'} not shown as words because Vocab cannot read {repairs.length === 1 ? 'it' : 'them'}. Nothing was changed or removed.</p>
				<ul class="space-y-1">
					{#each repairs as repair (repair.path)}
						<li class="flex flex-wrap items-center gap-2 break-words">
							<span class="min-w-0 flex-1"><code>{repair.path}</code>: {repair.reason}</span>
							{#if repair.id !== undefined && entries.repair.open !== repair.id}
								{@const id = repair.id}
								<Button size="xs" variant="outline" onclick={() => entries.repair.start(id)}>Repair as text</Button>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if words.length === 0}
			<p class="py-8 text-center text-muted-foreground">Your words will appear here. Add one above or browse the starter list.</p>
		{:else if shown.length === 0}
			<p class="py-8 text-center text-muted-foreground">No expressions match this search and stage.</p>
		{:else}
			<div class="space-y-3">
				{#each shown as entry (entry.id)}
					<EntryCard {entry} {entries} chosen={focusIds.includes(entry.id)} canChoose={focusIds.includes(entry.id) || selectedFocus.length < 3} onToggle={() => toggleFocus(entry.id)} />
				{/each}
			</div>
		{/if}
	</div>
	{#if selectedFocus.length}
		<section aria-label="Selected practice focus" class="border-t bg-background py-3">
			<div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 md:px-8">
				<p class="min-w-0 flex-1 basis-full text-sm sm:basis-auto">
					<span class="font-medium">{selectedFocus.length} of 3 selected</span>
					<span class="block max-h-20 overflow-y-auto wrap-anywhere text-muted-foreground">{selectedFocus.map((entry) => entry.text).join(' · ')}</span>
				</p>
				<Button class="ml-auto" variant="ghost" disabled={starting} onclick={() => focusIds = []}>Clear</Button>
				<Button disabled={starting} onclick={start}>{starting ? 'Saving the chat…' : 'Start chat'}</Button>
			</div>
		</section>
	{/if}
</div>
