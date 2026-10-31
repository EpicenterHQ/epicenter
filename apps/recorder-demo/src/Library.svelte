<!--
	One client's recordings, this browser's files or the repository: its
	notes and audio joined by id, each row read and edited through that
	client alone.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import type { ReactiveClient } from '@epicenter/svelte/client';
	import RecordingRow from './RecordingRow.svelte';
	import type { Recorder } from './contract.ts';
	import { recordingsOf } from './lib/recordings.ts';

	const {
		client,
		files,
	}: {
		/** The client this list's rows read audio through; fixed for the list's life. */
		client: Client<Recorder>;
		/** That client as Svelte state, wrapped once by the recorder: what the list shows and writes. */
		files: ReactiveClient<Recorder>;
	} = $props();
	const rows = $derived(
		recordingsOf({ notes: files.recordings.items, audio: files.audio.items }),
	);
	/** Why the listing failed; the rows still show what was listed before. */
	const unreadable = $derived(
		(files.recordings.error ?? files.audio.error)?.message ?? null,
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
			<RecordingRow {row} {client} {files} />
		{/each}
	</ul>
{/if}
