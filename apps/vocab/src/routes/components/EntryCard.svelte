<!--
	One saved word: its text, the learner's note, and the stage. The note and
	the stage are typed through the word's edit handle: a stage press is saved at once, a note
	a second after the last keystroke, even after the card goes away.
	A read that lands meanwhile never replaces the typing.
	Each save publishes the current whole source; outside writers may overwrite it.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { cn } from '@epicenter/ui/utils';
	import { type Entry, STAGE_LABELS, STAGES } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { describeFailure } from '$lib/failure.js';
	import { confirmDelete } from './word-actions.js';

	let { entry, entries, chosen, canChoose, onToggle }: {
		entry: Entry;
		entries: Entries;
		chosen: boolean;
		canChoose: boolean;
		onToggle: () => void;
	} = $props();

	// The list keys each card by its word; keep this card's original ID.
	// svelte-ignore state_referenced_locally
	const id = entry.id;
	/** Edits wait while the word is deleted or open as text, and once Vocab closes. */

	/** The folder's edit of the word, the note and stage typed over it. */
	// svelte-ignore state_referenced_locally
	const fileEdit = entries.document(id);
	/** The word with what is typed over it, or as the list read it while that is not known. */
	const shown = $derived(fileEdit.content?.issues === null ? fileEdit.content.fields : entry.row.fields);



	/** Delete once the note typed here is sent, so the delete removes what was saved last. */
	function remove() {
		confirmDelete(entries, entry);
	}
</script>

<article class={cn('rounded-lg border p-4', chosen && 'border-primary bg-accent/30')}>
	<div class="flex items-start justify-between gap-2">
		<Label class="min-h-11 min-w-0 flex-1 items-start text-base leading-relaxed select-text"><Checkbox class="mt-1 shrink-0" aria-label="Choose {entry.text} for chat" checked={chosen} disabled={!canChoose} onCheckedChange={onToggle} /><span class="min-w-0 flex-1 wrap-anywhere">{entry.text}</span></Label>
		<Button size="sm" variant="ghost-destructive" class="shrink-0"  onclick={remove}>Delete</Button>
	</div>
	<Textarea
		class="min-h-20 max-h-48 overflow-y-auto"
		aria-label="Your note for {entry.text}"
		placeholder="Your note"

		bind:value={() => shown.note, (typed) => toastOnError(fileEdit.setNote(typed), 'That change was not made')}
	/>
	{#if fileEdit.loadError}
		<p role="alert" class="text-sm text-destructive">{fileEdit.loadError.message}</p>
	{/if}
	<div class="mt-2 flex flex-wrap items-center gap-1" aria-label="Your stage for {entry.text}">
		{#each STAGES as option}<Button size="sm" variant={shown.stage === option ? 'default' : 'outline'} aria-pressed={shown.stage === option}  onclick={() => toastOnError(fileEdit.setStage(option), 'That change was not made')}>{STAGE_LABELS[option]}</Button>{/each}
		<span class="ml-auto text-xs text-muted-foreground" role="status">
			{#if fileEdit.saveError}
				Not saved: {describeFailure(fileEdit.saveError)} <Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit.save()}>Try again</Button>
			{:else if fileEdit.isDirty || fileEdit.isSaving}
				Saving…
			{/if}
		</span>
	</div>
</article>
