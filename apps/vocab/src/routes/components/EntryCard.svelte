<!--
	One saved word: its text, the learner's note, and the stage. Each note
	keystroke and stage press changes the word's draft, which is saved at
	once, one save at a time; a read that lands meanwhile never replaces it.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { Textarea } from '@epicenter/ui/textarea';
	import { cn } from '@epicenter/ui/utils';
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

	/** The word with its unsaved edit, if it has one. */
	const word = $derived(entries.shown(entry));
	/** Edits wait while the word is deleted or open as text. */
	const locked = $derived(entries.isLocked(entry.id));
</script>

<article class={cn('rounded-lg border p-4', chosen && 'border-primary bg-accent/30')}>
	<div class="flex items-start justify-between gap-2">
		<Label class="min-h-11 min-w-0 flex-1 items-start text-base leading-relaxed select-text"><Checkbox class="mt-1 shrink-0" aria-label="Choose {entry.text} for chat" checked={chosen} disabled={!canChoose} onCheckedChange={onToggle} /><span class="min-w-0 flex-1 wrap-anywhere">{entry.text}</span></Label>
		<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={locked} onclick={() => confirmDelete(entries, entry)}>Delete</Button>
	</div>
	<Textarea
		class="min-h-20 max-h-48 overflow-y-auto"
		aria-label="Your note for {entry.text}"
		placeholder="Your note"
		readonly={locked}
		bind:value={() => word.note, (note) => entries.inputNote(entry.id, note)}
	/>
	<div class="mt-2 flex flex-wrap items-center gap-1" aria-label="Your stage for {entry.text}">
		{#each STAGES as option}<Button size="sm" variant={word.stage === option ? 'default' : 'outline'} aria-pressed={word.stage === option} disabled={locked} onclick={() => entries.setStage(entry.id, option)}>{STAGE_LABELS[option]}</Button>{/each}
		<span class="ml-auto text-xs text-muted-foreground" role="status">{entries.isSaving(entry.id) ? 'Saving…' : ''}</span>
	</div>
</article>
