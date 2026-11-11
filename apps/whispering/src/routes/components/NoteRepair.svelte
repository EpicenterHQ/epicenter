<!--
	A note that does not read: why, and the repair (`NoteRepair` from
	`@epicenter/svelte/note-repair`: its text, what is wrong as typed, and
	Save repair, which saves the text through the note's editor). A save
	never fails: text that still does not read is written as typed, and the
	note stays here with its new problems. Delete removes it.
-->
<script lang="ts">
	import SharedNoteRepair from '@epicenter/svelte/note-repair';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { folder } from '$lib/app.js';
	import { whispering as contract } from '$lib/contract.js';
	import { notePath } from '$lib/deletion.js';
	import { getLibrary, type Repair } from '$lib/library.svelte.js';
	import { confirmDelete } from './file-actions.js';

	let { repair }: { repair: Repair } = $props();
	const library = getLibrary();
	const edit = $derived(folder[repair.collection].edit({ id: repair.id }));
</script>

<section class="flex flex-col gap-2 text-sm" data-testid="note-repair" data-path={notePath(repair)}>
	<p class="flex flex-wrap items-center gap-2 font-medium">
		<Badge variant="destructive">Needs repair</Badge>
		<code class="font-mono text-xs">{notePath(repair)}</code>
	</p>
	{#if repair.text === null}
		<p class="text-xs text-muted-foreground" data-testid="repair-reason">{repair.reason}</p>
		<p class="text-xs text-muted-foreground" role="status">It is not UTF-8 text, so it is not opened here. Delete it, or fix it where it is.</p>
	{:else}
		<SharedNoteRepair {contract} note={repair} {edit} />
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
