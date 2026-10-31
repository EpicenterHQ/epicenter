<!--
	The recorder over one client, the variant's store for the page's life:
	Record and Stop, then the recording's two writes through that client,
	its audio first and then its note, and below them the client's
	recordings (`Library`). The local variant passes this browser's files,
	the online one the repository; this component never chooses.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { timeId } from '@epicenter/definition/ids';
	import { fromClient } from '@epicenter/svelte/client';
	import Library from './Library.svelte';
	import type { Recorder } from './contract.ts';
	import { openMicrophone } from './lib/microphone.ts';
	import { startRecording } from './lib/record.ts';

	const {
		client,
		where,
	}: {
		/** The store recordings are written to and listed from; fixed for the component's life. */
		client: Client<Recorder>;
		/** Where that store is, for a recording that did not land there: "in this browser". */
		where: string;
	} = $props();

	// The one Svelte state over the client, for this recorder and its list.
	// svelte-ignore state_referenced_locally
	const files = fromClient(client);

	let problem = $state<string | null>(null);
	let recording = $state<ReturnType<typeof startRecording> | null>(null);
	let busy = $state(false);

	/** A finished recording: its note's fields, its audio, and whether the audio has landed. */
	type Finished = {
		id: string;
		title: string;
		recordedAt: string;
		durationMs: number;
		ext: string;
		bytes: Uint8Array;
		audioLanded: boolean;
	};
	/**
	 * Recordings the store did not take (a private window has no file
	 * storage; a full disk or an unreachable server refuses). Their bytes
	 * stay in this page, to save again or download, until one of those works
	 * or the page closes.
	 */
	let unsaved = $state.raw<
		(Finished & { reason: string; download: string })[]
	>([]);

	async function record() {
		problem = null;
		busy = true;
		try {
			recording = startRecording(await openMicrophone());
		} catch (cause) {
			problem = `Could not start recording: ${cause instanceof Error ? cause.message : cause}`;
		} finally {
			busy = false;
		}
	}

	/** Hold `finished` in this page, saying why the store did not take it. */
	function hold(finished: Finished, reason: string) {
		const held = unsaved.find((item) => item.id === finished.id);
		const download =
			held?.download ??
			URL.createObjectURL(new Blob([finished.bytes as Uint8Array<ArrayBuffer>]));
		unsaved = [
			...unsaved.filter((item) => item.id !== finished.id),
			{ ...finished, reason, download },
		];
	}

	/**
	 * Write `finished` to the store: its audio, then its note. A step that
	 * fails holds it in this page; saving again starts after the audio when
	 * it landed. A path already taken is this recording's own earlier
	 * attempt (its id is its moment), whose answer was lost, so it counts as
	 * written.
	 */
	async function keep(finished: Finished) {
		const { id, title, recordedAt, durationMs, ext, bytes } = finished;
		if (!finished.audioLanded) {
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
		if (held) URL.revokeObjectURL(held.download);
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
		busy = true;
		try {
			const { bytes, ext, durationMs } = await recording.stop();
			const recordedAt = new Date();
			await keep({
				id: timeId(recordedAt),
				title: `Recording ${recordedAt.toLocaleString()}`,
				recordedAt: recordedAt.toISOString(),
				durationMs,
				ext,
				bytes,
				audioLanded: false,
			});
		} catch (cause) {
			problem = `Recording failed: ${cause instanceof Error ? cause.message : cause}`;
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
		<a href={held.download} download={`${held.id}.${held.ext}`}>Download it</a>
	</p>
{/each}
<Library {client} {files} />
