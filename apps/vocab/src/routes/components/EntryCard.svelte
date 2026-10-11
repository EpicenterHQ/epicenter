<!--
	One saved word: its text, the learner's note, and the stage. Focusing the
	note opens the word; each keystroke and stage press of the open word then
	saves at once. A stage pressed on a word that is not open saves that word
	as the list showed it.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { cn } from '@epicenter/ui/utils';
	import { type Entry, STAGE_LABELS, STAGES } from '$lib/data.js';
	import type { EntriesState } from '$lib/entries.svelte.js';
	import SaveBar from '@epicenter/svelte/save-bar';
	import { confirmDelete, openWord } from './word-actions.js';

	let { entry, entries, chosen, canChoose, onToggle }: {
		entry: Entry;
		entries: EntriesState;
		chosen: boolean;
		canChoose: boolean;
		onToggle: () => void;
	} = $props();

	const item = $derived(entries.opened?.id === entry.id ? entries.opened : undefined);
	const session = $derived(item?.kind === 'word' ? item.session : undefined);
	const fields = $derived(entries.fieldsOf(entry));

	async function act(command: () => Promise<string | undefined>) {
		const problem = await command();
		if (problem) toast.error(problem);
	}
</script>

<article class={cn('rounded-lg border p-4', chosen && 'border-primary bg-accent/30')}>
	<div class="flex items-start justify-between gap-2">
		<Label class="min-h-11 min-w-0 flex-1 items-start text-base leading-relaxed select-text"><Checkbox class="mt-1 shrink-0" aria-label="Choose {entry.text} for chat" checked={chosen} disabled={!canChoose} onCheckedChange={onToggle} /><span class="min-w-0 flex-1 wrap-anywhere">{entry.text}</span></Label>
		<Button size="sm" variant="ghost-destructive" class="shrink-0" disabled={session?.locked} onclick={() => confirmDelete(entries, entry)}>Delete</Button>
	</div>
	<!-- Read-only until this word is open; focusing it opens the word. -->
	<Textarea
		class="min-h-20 max-h-48 overflow-y-auto"
		aria-label="Your note for {entry.text}"
		placeholder={item?.kind === 'loading' ? 'Opening…' : 'Your note'}
		readonly={session === undefined || session.locked}
		onfocus={() => void openWord(entries, entry.id)}
		bind:value={() => fields.note, (note) => entries.inputNote(entry.id, note)}
	/>
	{#if item?.kind === 'failed'}
		<p role="alert" class="mt-2 text-xs text-destructive">{item.message}</p>
	{/if}
	<div class="mt-2 flex flex-wrap gap-1" aria-label="Your stage for {entry.text}">
		{#each STAGES as option}<Button size="sm" variant={fields.stage === option ? 'default' : 'outline'} aria-pressed={fields.stage === option} disabled={session?.locked} onclick={() => act(() => entries.setStage(entry, option))}>{STAGE_LABELS[option]}</Button>{/each}
	</div>
	{#if session}
		<SaveBar
			save={session.state}
			review={session.review}
		hideWhenSaved
		class="mt-2"
			onRetry={() => session.retry()}
			onKeepMine={() => entries.keepMine(session)}
			onReloadTheirs={() => entries.reloadTheirs(session)}
		/>
	{/if}
</article>
