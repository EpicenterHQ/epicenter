<!--
	One store's recordings, this browser's files or the repository: its
	notes and audio joined by id, each row read and edited through that
	store alone.
-->
<script lang="ts">
	import type { Folder } from '@epicenter/folder/core';
	import RecordingRow from './RecordingRow.svelte';
	import type { Recorder } from './contract.ts';
	import { recordingsOf } from './lib/recordings.ts';

	const {
		files,
	}: {
		/** The recorder's store as a folder, read through `reactive`: what the list shows, writes and plays. */
		files: Folder<Recorder>;
	} = $props();
	const rows = $derived(
		recordingsOf({ notes: files.recordings.items(), audio: files.audio.items() }),
	);
	/** Why the listing failed; the rows still show what was listed before. */
	const unreadable = $derived(
		(files.recordings.error() ?? files.audio.error())?.message ?? null,
	);
</script>

{#if unreadable}
	<p class="problem" role="alert">{unreadable}</p>
{/if}
{#if rows.length === 0}
	<p class="meta">No recordings yet.</p>
{:else}
	<ul aria-label="Recordings">
		{#each rows as row (row.id)}
			<RecordingRow {row} {files} />
		{/each}
	</ul>
{/if}
