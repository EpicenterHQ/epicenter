<!--
	A file at a note's or folder's path that does not read as one: its text
	and why. Saving fixed text replaces the whole file (`replace`), which
	must then read and fit the contract; until it does, the text stays here
	with the reason it was refused. Delete removes the file.
-->
<script lang="ts">
	import { describeIssues, type InvalidNoteOf } from '@epicenter/definition/contract';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { NoteCollection } from '$lib/honeycrisp.svelte.js';

	let {
		file,
		kind,
		save,
		onDelete,
	}: {
		file: Pick<InvalidNoteOf<NoteCollection>, 'path' | 'text' | 'issues'>;
		/** What the file should read as, in a person's words. */
		kind: 'note' | 'folder';
		/** Replace the file with `text`. */
		save: (text: string) => Promise<{ error: { name: string; message: string; issues?: { field: string; message: string }[] } | null }>;
		onDelete: () => void;
	} = $props();

	/** The repair's text, once the person has changed it; until then the file's. */
	let repair = $state<string | null>(null);
	let saving = $state(false);
	let problem = $state<string | null>(null);

	async function saveRepair(text: string) {
		saving = true;
		problem = null;
		const { error } = await save(text);
		saving = false;
		if (error !== null) {
			problem = error.name === 'Invalid' && error.issues ? describeIssues(error.issues) : error.message;
			return;
		}
		repair = null;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
		<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{file.path}</h2>
	</div>
	<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
		<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
			<Badge variant="destructive">Needs repair</Badge>
			{file.text === null
				? `This file is not text, so Honeycrisp cannot show it.`
				: `This file does not read as a ${kind}. Fix its text and save it.`}
		</p>
		<p class="text-muted-foreground">{describeIssues(file.issues)}</p>
	</div>
	{#if file.text !== null}
		{@const text = repair ?? file.text}
		<form
			class="flex min-h-48 flex-1 flex-col gap-2 px-3 py-3 sm:px-4"
			onsubmit={(event) => {
				event.preventDefault();
				void saveRepair(text);
			}}
		>
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none font-mono text-xs"
				aria-label="Text of {file.path}"
				spellcheck={false}
				value={text}
				oninput={(event) => (repair = event.currentTarget.value)}
			/>
			{#if problem}
				<p class="text-xs text-destructive" role="alert">Not saved: {problem}</p>
			{/if}
			<div class="flex gap-2">
				<Button type="submit" size="sm" disabled={saving}>Save repair</Button>
				{#if repair !== null}
					<Button size="sm" variant="ghost" onclick={() => ((repair = null), (problem = null))}>Discard</Button>
				{/if}
			</div>
		</form>
	{/if}
	<div class="mt-auto flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={onDelete}>Delete</Button>
	</div>
</div>
