<!--
	One recording in a view, read and edited through that view's client:
	its title to rename, its audio to play, and Delete.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { cacheOf } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import type { Recorder } from './contract.ts';
	import { device } from './lib/device.ts';
	import type { RecordingRow } from './lib/recordings.ts';

	const {
		row,
		client,
		cached,
	}: {
		row: RecordingRow;
		/** The view's client, which this row reads and writes; fixed for the row's life. */
		client: Client<Recorder>;
		/** Whether this device's cache may hold the audio, at the version `row` shows. */
		cached: boolean;
	} = $props();

	// svelte-ignore state_referenced_locally
	const files = fromClient(client);

	type Note = NonNullable<RecordingRow['note']>;
	/**
	 * What the person typed and has not saved, with the note as it was when
	 * they began (null once a clash has shown them the note as it is now);
	 * no draft shows the note's title, however it changes.
	 */
	let draft = $state<{ title: string; base: Note | null } | null>(null);
	let status = $state<string | null>(null);
	let audioUrl = $state<string | null>(null);

	onDestroy(() => {
		if (audioUrl) URL.revokeObjectURL(audioUrl);
	});

	/** The audio's bytes: from this device's cache when it holds this version, else from the client. */
	async function audioBytes(ext: string) {
		if (cached && row.audioVersion !== null) {
			const hit = await cacheOf(device).read(
				{ collection: 'audio', id: row.id, ext },
				{ version: row.audioVersion },
			);
			if (hit.data) return Ok(hit.data);
		}
		return client.audio.get({ id: row.id, ext });
	}

	async function play() {
		if (row.ext === null) return;
		status = 'Loading…';
		const audio = await audioBytes(row.ext);
		if (audio.error !== null) {
			status = audio.error.message;
			return;
		}
		if (audioUrl) URL.revokeObjectURL(audioUrl);
		audioUrl = URL.createObjectURL(
			new Blob([audio.data.bytes as Uint8Array<ArrayBuffer>]),
		);
		status = null;
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!row.note || draft === null) return;
		status = 'Saving…';
		const { title, base } = draft;
		// Over the note as it was when the typing began: a change to other
		// fields since is carried over; a new title since is a clash.
		const renamed = await files.recordings.update(
			{ id: row.id },
			{ title },
			base ? { base } : {},
		);
		if (renamed.error?.name === 'Conflict' && renamed.error.current !== null) {
			// Someone else renamed it. The row now shows their note; keep the
			// draft, and saving again applies it over theirs.
			const theirs = files.recordings.get({ id: row.id })?.title;
			draft = { title, base: null };
			status = `Changed elsewhere to “${theirs}”; your title is kept. Save again to apply it.`;
			return;
		}
		if (renamed.error !== null) {
			status = renamed.error.message;
			return;
		}
		draft = null;
		status = 'Saved';
	}

	/** Delete the note, then the audio; a failure says why and leaves the rest to delete again. */
	async function remove() {
		status = 'Deleting…';
		if (row.note) {
			const deleted = await files.recordings.delete({ id: row.id });
			if (deleted.error !== null) {
				status = deleted.error.message;
				return;
			}
		}
		if (row.ext !== null) {
			const deleted = await files.audio.delete({ id: row.id, ext: row.ext });
			if (deleted.error !== null) {
				status = deleted.error.message;
				return;
			}
		}
		status = null;
	}

	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
</script>

<li data-id={row.id}>
	{#if row.note}
		<form class="row" onsubmit={save}>
			<input
				aria-label="Title"
				value={draft?.title ?? row.note.title}
				oninput={(event) =>
					(draft = {
						title: event.currentTarget.value,
						base: draft ? draft.base : row.note,
					})}
			/>
			<button type="submit">Save title</button>
		</form>
	{:else}
		<div class="row"><strong>Untitled recording</strong></div>
	{/if}
	<div class="row meta">
		{#if row.note}
			<span>{new Date(row.note.recordedAt).toLocaleString()}</span>
			<span data-testid="duration">{seconds(row.note.durationMs)}</span>
		{/if}
		{#if row.ext}
			<button onclick={play}>Play</button>
		{/if}
		<button onclick={remove}>Delete</button>
		{#if status}
			<span data-testid="status">{status}</span>
		{/if}
	</div>
	{#if audioUrl}
		<audio controls autoplay src={audioUrl}></audio>
	{/if}
</li>
