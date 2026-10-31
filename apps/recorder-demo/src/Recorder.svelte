<!--
	The recorder over one client, the variant's store for the page's life:
	Record and Stop, then what the store still needs (the note, and the
	audio if it was held in the page), and below them the client's
	recordings (`Library`). The variant passes its store and how it records
	(`lib/record.ts`): the local one this browser's files, written as it
	records; the online one the repository, written at Stop. This component
	never chooses.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { timeId } from '@epicenter/definition/ids';
	import { fromClient } from '@epicenter/svelte/client';
	import Library from './Library.svelte';
	import type { Recorder } from './contract.ts';
	import type { Record, Take } from './lib/record.ts';

	const {
		client,
		record: begin,
		where,
	}: {
		/** The store recordings are written to and listed from; fixed for the component's life. */
		client: Client<Recorder>;
		/** How this variant records into that store. */
		record: Record;
		/** Where that store is, for a recording that did not land there: "in this browser". */
		where: string;
	} = $props();

	// The one Svelte state over the client, for this recorder and its list.
	// svelte-ignore state_referenced_locally
	const files = fromClient(client);

	let problem = $state<string | null>(null);
	let recording = $state<{ id: string; at: Date; take: Take } | null>(null);
	let busy = $state(false);

	/**
	 * A finished recording: its note's fields, and its audio, already in the
	 * store (`bytes` null) or held in the page until the store takes it.
	 */
	type Finished = {
		id: string;
		title: string;
		recordedAt: string;
		durationMs: number;
		ext: string;
		bytes: Uint8Array | null;
		audioLanded: boolean;
	};
	/**
	 * Recordings the store did not take (a full disk or an unreachable server
	 * refuses). What is still in the page stays here, to save again or
	 * download, until one of those works or the page closes.
	 */
	let unsaved = $state.raw<
		(Finished & { reason: string; download: string | null })[]
	>([]);

	async function record() {
		problem = null;
		busy = true;
		try {
			const at = new Date();
			const id = timeId(at);
			const started = await begin(id);
			if (started.error !== null)
				problem = `Could not start recording: ${started.error.message}`;
			else recording = { id, at, take: started.data };
		} finally {
			busy = false;
		}
	}

	/** Hold `finished` in this page, saying why the store did not take it. */
	function hold(finished: Finished, reason: string) {
		const held = unsaved.find((item) => item.id === finished.id);
		const download =
			held?.download ??
			(finished.bytes === null
				? null
				: URL.createObjectURL(
						new Blob([finished.bytes as Uint8Array<ArrayBuffer>]),
					));
		unsaved = [
			...unsaved.filter((item) => item.id !== finished.id),
			{ ...finished, reason, download },
		];
	}

	/**
	 * Write what the store does not have of `finished`: its audio, unless it
	 * was written as it recorded, then its note. A step that fails holds it
	 * in this page; saving again starts after the audio when it landed. A
	 * path already taken is this recording's own earlier attempt (its id is
	 * its moment), whose answer was lost, so it counts as written.
	 */
	async function keep(finished: Finished) {
		const { id, title, recordedAt, durationMs, ext, bytes } = finished;
		if (!finished.audioLanded && bytes !== null) {
			const audio = await files.audio.create({ id, ext, bytes });
			if (audio.error !== null && audio.error.name !== 'Occupied')
				return hold(finished, audio.error.message);
			finished = { ...finished, audioLanded: true };
		}
		const note = await files.recordings.create({
			id,
			title,
			recordedAt,
			durationMs,
		});
		if (note.error !== null && note.error.name !== 'Occupied')
			return hold(finished, note.error.message);
		const held = unsaved.find((item) => item.id === id);
		if (held?.download) URL.revokeObjectURL(held.download);
		unsaved = unsaved.filter((item) => item.id !== id);
	}

	async function saveAgain(finished: Finished) {
		busy = true;
		try {
			await keep(finished);
		} finally {
			busy = false;
		}
	}

	async function stop() {
		if (!recording) return;
		const { id, at, take } = recording;
		busy = true;
		try {
			const stopped = await take.stop();
			if (stopped.error !== null) {
				problem = `Recording failed: ${stopped.error.message}`;
				return;
			}
			const { ext, durationMs } = stopped.data;
			await keep({
				id,
				title: `Recording ${at.toLocaleString()}`,
				recordedAt: at.toISOString(),
				durationMs,
				ext,
				bytes: stopped.data.written ? null : stopped.data.bytes,
				audioLanded: stopped.data.written,
			});
		} finally {
			recording = null;
			busy = false;
		}
	}
</script>

<p class="row">
	{#if recording}
		<button onclick={stop} disabled={busy}>Stop</button>
		<span class="meta">Recording…</span>
	{:else}
		<button onclick={record} disabled={busy}>Record</button>
	{/if}
</p>
{#if problem}
	<p class="problem" role="alert">{problem}</p>
{/if}
{#each unsaved as held (held.id)}
	<p class="problem row" data-testid="unsaved">
		<span>{held.title} is not saved {where}: {held.reason}</span>
		<button onclick={() => saveAgain(held)} disabled={busy}>Save again</button>
		{#if held.download}
			<a href={held.download} download={`${held.id}.${held.ext}`}>Download it</a>
		{/if}
	</p>
{/each}
<Library {client} {files} />
