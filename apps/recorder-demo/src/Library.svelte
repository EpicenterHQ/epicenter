<!--
	One view's recordings: the notes and audio of one client, this device's
	or the repository's, each row read and edited through that client alone.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { fromClient } from '@epicenter/svelte/client';
	import RecordingRow from './RecordingRow.svelte';
	import type { Recorder } from './contract.ts';
	import { recordingsOf } from './lib/recordings.ts';

	const {
		client,
		cached = false,
	}: {
		/** The client this view reads and writes; fixed for the view's life. */
		client: Client<Recorder>;
		/** Whether this device's cache may hold the audio: the repository's view, whose audio this device may have uploaded. */
		cached?: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	const files = fromClient(client);
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
			<RecordingRow {row} {client} {cached} />
		{/each}
	</ul>
{/if}
