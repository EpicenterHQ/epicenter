<!--
	A file at a note's or folder's path that does not read as one: its path,
	what it should read as, and the repair (`NoteRepair`: its text, what is
	wrong as typed, saved with `replace` over the version the repair began
	from, a refusal kept beside the text). Delete removes the file.
-->
<script lang="ts">
	import NoteRepair from '@epicenter/svelte/note-repair';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import type { ComponentProps } from 'svelte';
	import { honeycrisp } from '$lib/contract.js';

	let {
		file,
		kind,
		replace,
		onDelete,
	}: {
		file: ComponentProps<typeof NoteRepair>['note'];
		/** What the file should read as, in a person's words. */
		kind: 'note' | 'folder';
		/** Replace the file with `text`, over the version the repair began from. */
		replace: ComponentProps<typeof NoteRepair>['replace'];
		onDelete: () => void;
	} = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
		<h2 class="min-w-0 flex-1 truncate font-mono text-sm">{file.path}</h2>
	</div>
	<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status">
		<p class="flex flex-wrap items-center gap-2 font-medium">
			<Badge variant="destructive">Needs repair</Badge>
			{file.text === null
				? `This file is not text, so Honeycrisp cannot show it.`
				: `This file does not read as a ${kind}. Fix its text and save it.`}
		</p>
	</div>
	{#if file.text !== null}
		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<NoteRepair contract={honeycrisp} note={file} {replace} />
		</div>
	{/if}
	<div class="mt-auto flex shrink-0 items-center gap-2 border-t px-4 py-2">
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={onDelete}>Delete</Button>
	</div>
</div>
