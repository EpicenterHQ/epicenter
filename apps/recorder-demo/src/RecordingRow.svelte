<script lang="ts">
	import { cacheOf } from '@epicenter/folder/browser';
	import { onDestroy } from 'svelte';
	import { Ok } from 'wellcrafted/result';
	import { getDevice, getRemote } from './lib/context.ts';
	import type { RecordingRow } from './lib/recordings.ts';

	const { row }: { row: RecordingRow } = $props();

	// A repository or cache row exists only while signed in, under the
	// remote's subtree. A row keeps its id and side for its life: rows are
	// keyed by both, so an upload replaces the device row with a new
	// repository one.
	const device = getDevice();
	// svelte-ignore state_referenced_locally
	const side = row.where === 'device' ? device : getRemote();

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

	/** The audio's bytes: from the device's cache when it holds them, else from where the row lives. */
	async function audioBytes(ext: string) {
		if (row.cached) {
			// Online, only the repository's version answers; offline, the cache is all there is.
			const cached = await cacheOf(device.client).read(
				{ collection: 'audio', id: row.id, ext },
				row.audioVersion ? { version: row.audioVersion } : {},
			);
			if (cached.data) return Ok(cached.data);
		}
		return side.client.audio.get({ id: row.id, ext });
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
		const renamed = await side.files.recordings.update(
			{ id: row.id },
			{ title },
			base ? { base } : {},
		);
		if (renamed.error?.name === 'Conflict' && renamed.error.current !== null) {
			// Someone else renamed it. The row now shows their note; keep the
			// draft, and saving again applies it over theirs.
			const theirs = side.files.recordings.get({ id: row.id })?.title;
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

	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
</script>

<li data-id={row.id} data-where={row.where}>
	{#if row.where === 'repository' && row.note}
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
