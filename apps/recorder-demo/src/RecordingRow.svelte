<script lang="ts">
	import { cacheOf } from '@epicenter/folder/browser';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import { getDevice, getRemote } from './lib/context.ts';
	import type { RecordingRow } from './lib/recordings.ts';

	const {
		row,
		onchange,
	}: { row: RecordingRow; onchange: () => Promise<void> } = $props();

	// A repository or cache row exists only while signed in, under the
	// remote's subtree. A row keeps its id and side for its life: rows are
	// keyed by both, so an upload replaces the device row with a new
	// repository one.
	const device = getDevice();
	// svelte-ignore state_referenced_locally
	const client = row.where === 'device' ? device : getRemote();

	/** What the person typed and has not saved; null shows the note's title, however it changes. */
	let draft = $state<string | null>(null);
	let status = $state<string | null>(null);
	let audioUrl = $state<string | null>(null);

	onDestroy(() => {
		if (audioUrl) URL.revokeObjectURL(audioUrl);
	});

	/** The audio's bytes: from the device's cache when it holds them, else from where the row lives. */
	async function audioBytes(ext: string) {
		if (row.cached) {
			// Online, only the repository's version answers; offline, the cache is all there is.
			const cached = await cacheOf(device).read(
				{ collection: 'audio', id: row.id, ext },
				row.audioVersion ? { version: row.audioVersion } : {},
			);
			if (cached.data) return Ok(cached.data);
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
		const renamed = await client.recordings.update(
			{ id: row.id },
			{ title: draft },
			{ over: row.note.version },
		);
		if (renamed.error?.name === 'Conflict' && renamed.error.current !== null) {
			// The note moved since it was read. Show it as it is now and keep
			// the draft: saving again writes the title over that version.
			await onchange();
			status = 'Changed elsewhere; your title is kept. Save again to apply it.';
			return;
		}
		if (renamed.error !== null) {
			status = renamed.error.message;
			return;
		}
		// Show the saved title from the listing, not the draft.
		await onchange();
		draft = null;
		status = 'Saved';
	}

	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
</script>

<li data-id={row.id} data-where={row.where}>
	{#if row.where === 'repository' && row.note}
		<form class="row" onsubmit={save}>
			<input
				aria-label="Title"
				value={draft ?? row.note.title}
				oninput={(event) => (draft = event.currentTarget.value)}
			/>
			<button type="submit">Save title</button>
		</form>
	{:else}
		<div class="row">
			<strong data-testid="title">
				{row.note?.title ??
					(row.where === 'cache' ? 'Cached recording' : 'Untitled recording')}
			</strong>
		</div>
	{/if}
	<div class="row meta">
		{#if row.where === 'device'}
			<span class="pending">not uploaded yet</span>
		{:else if row.cached}
			<span class="cached">cached</span>
		{/if}
		{#if row.note}
			<span>{new Date(row.note.recordedAt).toLocaleString()}</span>
			<span data-testid="duration">{seconds(row.note.durationMs)}</span>
		{/if}
		{#if row.ext}
			<button onclick={play}>Play</button>
		{/if}
		{#if status}
			<span data-testid="status">{status}</span>
		{/if}
	</div>
	{#if audioUrl}
		<audio controls autoplay src={audioUrl}></audio>
	{/if}
</li>
