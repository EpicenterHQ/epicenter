<!--
	"On this device" (decision 76): recording, and the recordings in this
	browser's files (OPFS), signed in or not, online or not. Each recording
	is kept here first as one capture (`saveCapture`); signed in, the
	uploader moves it to the repository, where "Synced" shows it.
-->
<script lang="ts">
	import { timeId } from '@epicenter/definition/ids';
	import { saveCapture } from '@epicenter/folder/browser';
	import Library from './Library.svelte';
	import { device } from './lib/device.ts';
	import { openMicrophone } from './lib/microphone.ts';
	import { startRecording } from './lib/record.ts';

	let problem = $state<string | null>(null);
	let recording = $state<ReturnType<typeof startRecording> | null>(null);
	let busy = $state(false);

	/** A finished recording: its note's fields and its audio. */
	type Finished = {
		id: string;
		title: string;
		recordedAt: string;
		durationMs: number;
		ext: string;
		bytes: Uint8Array;
	};
	/**
	 * Recordings the device could not keep (a private window has no file
	 * storage; a full disk refuses). Their bytes stay in this page, to save
	 * again or download, until one of those works or the page closes.
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

	/**
	 * Keep `finished` on the device as one capture, its audio and its note,
	 * or hold it in this page when that fails. Saving again with the same
	 * recording picks up what an earlier attempt wrote and finishes.
	 */
	async function keep(finished: Finished) {
		const { id, title, recordedAt, durationMs, ext, bytes } = finished;
		const saved = await saveCapture(device, {
			id,
			files: [
				{ collection: 'audio', value: { id, ext, bytes } },
				{ collection: 'recordings', value: { id, title, recordedAt, durationMs } },
			],
		});
		const held = unsaved.find((item) => item.id === id);
		if (saved.error === null) {
			if (held) URL.revokeObjectURL(held.download);
			unsaved = unsaved.filter((item) => item.id !== id);
			return;
		}
		const download =
			held?.download ??
			URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
		unsaved = [
			...unsaved.filter((item) => item.id !== id),
			{ ...finished, reason: saved.error.message, download },
		];
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
		<span>{held.title} is not kept on this device: {held.reason}</span>
		<button onclick={() => saveAgain(held)} disabled={busy}>Save again</button>
		<a href={held.download} download={`${held.id}.${held.ext}`}>Download it</a>
	</p>
{/each}
<Library client={device} />
