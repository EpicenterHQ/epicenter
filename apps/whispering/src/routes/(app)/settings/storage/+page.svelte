<!--
	Settings · Storage. Where the recordings are and how many there are.
	Their size, how long to keep them, opening the folder, and export are the
	target and not built yet.
-->
<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { createQuery } from '@tanstack/svelte-query';
	import { files } from '#lib/platform/index.ts';
	import { recordingsQueries } from '#lib/queries.ts';

	const list = createQuery(() => recordingsQueries.list());
	const count = $derived(list.data?.length ?? 0);
</script>

<svelte:head><title>Storage · Whispering</title></svelte:head>

<Field.Set>
	<Field.Legend>Storage</Field.Legend>
	<Field.Description>
		{count.toLocaleString()} {count === 1 ? 'recording' : 'recordings'}, kept in {files.keptIn} as a
		Markdown note and an audio file each.
	</Field.Description>
	<Field.Group>
		{#each [
			{ label: 'Size on disk', note: 'Not built yet.' },
			{ label: 'Keep recordings', note: 'Everything, the last N, or N days. Not built yet.' },
			{ label: 'Open the folder, and export', note: 'Not built yet.' },
		] as row (row.label)}
			<Field.Field>
				<Field.Label>{row.label}</Field.Label>
				<Field.Description>{row.note}</Field.Description>
			</Field.Field>
		{/each}
	</Field.Group>
</Field.Set>
