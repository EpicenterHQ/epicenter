<!--
	One saved word: its text, the learner's note, and the stage. A stage
	press is sent at once. The note is the word's field draft: sent a second
	after the last keystroke, when the learner leaves it, and when the card
	goes away; a read that lands meanwhile never replaces it. Each sets its
	field on the word's file as it is now (ADR-0576).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { Textarea } from '@epicenter/ui/textarea';
	import { cn } from '@epicenter/ui/utils';
	import { onDestroy } from 'svelte';
	import { type Entry, STAGE_LABELS, STAGES } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { confirmDelete } from './word-actions.js';

	let { entry, entries, chosen, canChoose, onToggle }: {
		entry: Entry;
		entries: Entries;
		chosen: boolean;
		canChoose: boolean;
		onToggle: () => void;
	} = $props();

	// The list keys each card by its word. While a card goes away, its props
	// may already read another word, so a note sent then uses this one.
	// svelte-ignore state_referenced_locally
	const id = entry.id;
	/** Edits wait while the word is deleted or open as text, and once Vocab closes. */
	const locked = $derived(entries.isLocked(id));
	/** The note typed and not yet saved. */
	// svelte-ignore state_referenced_locally
	const note = entries.noteOf(id);
	// The draft outlives the card; send what is typed now.
	onDestroy(() => void note.save());

	/** Delete once the note typed here is sent, so the delete removes what was saved last. */
	function remove() {
		void note.save();
		confirmDelete(entries, entry);
	}
</script>

<article class={cn('rounded-lg border p-4', chosen && 'border-primary bg-accent/30')}>
	<div class="flex items-start justify-between gap-2">
		<Label class="min-h-11 min-w-0 flex-1 items-start text-base leading-relaxed select-text"><Checkbox class="mt-1 shrink-0" aria-label="Choose {entry.text} for chat" checked={chosen} disabled={!canChoose} onCheckedChange={onToggle} /><span class="min-w-0 flex-1 wrap-anywhere">{entry.text}</span></Label>
		<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={locked} onclick={remove}>Delete</Button>
	</div>
	<Textarea
		class="min-h-20 max-h-48 overflow-y-auto"
		aria-label="Your note for {entry.text}"
		placeholder="Your note"
		readonly={locked}
		bind:value={
			() => note.shown(entry.note),
			(typed) => {
				if (entries.canEdit(id)) note.change(typed);
			}
		}
		onblur={() => void note.save()}
	/>
	<div class="mt-2 flex flex-wrap items-center gap-1" aria-label="Your stage for {entry.text}">
		{#each STAGES as option}<Button size="sm" variant={entry.stage === option ? 'default' : 'outline'} aria-pressed={entry.stage === option} disabled={locked} onclick={() => entries.setStage(id, option)}>{STAGE_LABELS[option]}</Button>{/each}
		<span class="ml-auto text-xs text-muted-foreground" role="status">
			{#if note.saving}
				Saving…
			{:else if note.error}
				Not saved. <Button variant="link" size="xs" class="h-auto p-0" onclick={() => void note.save()}>Try again</Button>
			{/if}
		</span>
	</div>
</article>
