<!--
	A note that does not read: why, its text to repair (checked against its
	kind's fields as it is typed, so the person sees what is wrong before saving),
	and Save repair, which writes the text as typed. Text that still does not
	read is written anyway, and the note stays here with its new problems.
	A note changed elsewhere since it was shown is not overwritten: the newer
	text shows, and the typing stays to save again. Delete removes it.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { folder } from '$lib/app.js';
	import { notePath } from '$lib/deletion.js';
	import { checkNote, NOTES } from '$lib/format/folder.js';
	import { getLibrary, type Repair } from '$lib/library.svelte.js';
	import { confirmDelete } from './file-actions.js';

	let { repair }: { repair: Repair } = $props();
	const library = getLibrary();
	const path = $derived(notePath(repair));

	/** The text as the person changed it; until then the note's. */
	let typed = $state<string | null>(null);
	let saving = $state(false);
	let problem = $state<string | null>(null);

	const text = $derived(typed ?? repair.text ?? '');
	/** What is wrong with the text as it stands, each with its line when it has one. */
	const problems = $derived(
		typed === null
			? repair.issues.map(({ message }) => message)
			: (checkNote(NOTES[repair.collection].fields, text).error ?? []).map(({ line, message }) =>
					line === undefined ? message : `Line ${line}: ${message}`,
				),
	);

	async function save() {
		const saved = text;
		saving = true;
		const written = await folder[repair.collection].replace({ id: repair.id }, saved);
		saving = false;
		problem = written.error?.message ?? null;
		if (written.error === null && typed === saved) typed = null;
	}
</script>

<section class="flex flex-col gap-2 text-sm" data-testid="note-repair" data-path={path}>
	<p class="flex flex-wrap items-center gap-2 font-medium">
		<Badge variant="destructive">Needs repair</Badge>
		<code class="font-mono text-xs">{path}</code>
	</p>
	{#if repair.text === null}
		<p class="text-xs text-muted-foreground" data-testid="repair-reason">{repair.reason}</p>
		<p class="text-xs text-muted-foreground" role="status">It is not UTF-8 text, so it is not opened here. Delete it, or fix it where it is.</p>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="needs-repair">
			{#if problems.length > 0}
				<ul class="list-inside list-disc text-xs text-muted-foreground" aria-label="Problems">
					{#each problems as item}<li>{item}</li>{/each}
				</ul>
			{:else}
				<p class="text-xs text-muted-foreground">This text reads. Save it to repair the note.</p>
			{/if}
			<form
				class="flex min-h-0 flex-1 flex-col gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<Textarea
					class="min-h-32 flex-1 field-sizing-fixed resize-none font-mono text-xs"
					aria-label="Text of {path}"
					value={text}
					oninput={(event) => (typed = event.currentTarget.value)}
				/>
				{#if problem}
					<p class="text-xs text-destructive" role="alert" data-testid="repair-problem">{problem}</p>
				{/if}
				<div class="flex gap-2">
					<Button type="submit" size="sm" disabled={saving}>Save repair</Button>
					{#if typed !== null}
						<Button size="sm" variant="ghost" onclick={() => (typed = null)}>Discard</Button>
					{/if}
				</div>
			</form>
		</div>
	{/if}
	<div class="flex items-center gap-1">
		<Button
			size="sm"
			variant="destructive"
			onclick={() => confirmDelete(library, { collection: repair.collection, id: repair.id })}
			data-testid="repair-delete"
		>
			Delete
		</Button>
	</div>
</section>
