<!--
	Settings · Storage. Where the recordings are and how many there are.
	Their size, how long to keep them, opening the folder, and export are the
	target and not built yet.
-->
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { files } from '#lib/platform/index.ts';
	import { recordingsQueries } from '#lib/queries.ts';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';

	const list = createQuery(() => recordingsQueries.list());
	const count = $derived(list.data?.length ?? 0);
</script>

<svelte:head><title>Storage · Whispering</title></svelte:head>

<SettingsSection title="Storage" description="Each recording is a Markdown note and an audio file, kept in {files.keptIn}.">
	<SettingsRow label="Recordings">
		<span class="text-sm tabular-nums">{count.toLocaleString()}</span>
	</SettingsRow>
	<SettingsRow label="Size on disk" description="Not built yet." disabled />
	<SettingsRow label="Keep recordings" description="Everything, the last N, or N days. Not built yet." disabled />
	<SettingsRow label="Open the folder, and export" description="Not built yet." disabled />
</SettingsSection>
