<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { timeId } from '@epicenter/definition/ids';
	import type { Uploader } from '@epicenter/folder/remote';
	import RecordingRow from './RecordingRow.svelte';
	import type { Recorder } from './contract.ts';
	import { getDevice } from './lib/context.ts';
	import { startRecording } from './lib/record.ts';
	import { mergeRecordings, type RecordingRow as Row } from './lib/recordings.ts';
	import { saveRecording } from './lib/save.ts';
	import { openMicrophone } from './lib/microphone.ts';

	const {
		remote,
		uploader = null,
	}: { remote: Client<Recorder> | null; uploader?: Uploader | null } =
		$props();

	const device = getDevice();

	let rows = $state.raw<Row[]>([]);
	let problem = $state<string | null>(null);
	let recording = $state<ReturnType<typeof startRecording> | null>(null);
	let busy = $state(false);

	type Finished = Parameters<typeof saveRecording>[1];
	/**
	 * Recordings the device could not keep (a private window has no file
	 * storage; a full disk refuses). Their bytes stay in this page, to save
	 * again or download, until one of those works or the page closes.
	 */
	let unsaved = $state.raw<
		(Finished & { reason: string; download: string })[]
	>([]);

	/** Read both sides again; only the latest read is shown. */
	let reads = 0;
	async function refresh() {
		const read = ++reads;
		const [notes, audio] = await Promise.all([
			device.recordings.list(),
			device.audio.list(),
		]);
		const repository = remote
			? await Promise.all([remote.recordings.list(), remote.audio.list()])
			: null;
		if (read !== reads) return;
		const failed = [notes, audio, ...(repository ?? [])].find(
			(listed) => listed.error !== null,
		);
		problem = failed?.error?.message ?? null;
		rows = mergeRecordings(
			{ notes: notes.data?.items ?? [], audio: audio.data?.items ?? [] },
			repository && {
				notes: repository[0].data?.items ?? [],
				audio: repository[1].data?.items ?? [],
			},
		);
	}

	$effect(() => {
		void refresh();
		void uploader?.drain().then(refresh);
		// The uploader runs on its own (on a capture, on `online`, on retry)
		// and tells no one: look again while anything waits on this device.
		const timer = setInterval(() => {
			if (uploader && rows.some((row) => row.where === 'device'))
				void refresh();
		}, 1000);
		return () => clearInterval(timer);
	});

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

	/** Keep `finished` on the device, or hold it in this page when that fails. */
	async function keep(finished: Finished) {
		const saved = await saveRecording(device, finished);
		const held = unsaved.find(({ id }) => id === finished.id);
		if (saved.error === null) {
			if (held) URL.revokeObjectURL(held.download);
			unsaved = unsaved.filter(({ id }) => id !== finished.id);
			return;
		}
		const download =
			held?.download ??
			URL.createObjectURL(
				new Blob([finished.bytes as Uint8Array<ArrayBuffer>]),
			);
		unsaved = [
			...unsaved.filter(({ id }) => id !== finished.id),
			{ ...finished, reason: saved.error.message, download },
		];
	}

	async function saveAgain(finished: Finished) {
		busy = true;
		try {
			await keep(finished);
		} finally {
			busy = false;
			await refresh();
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
			await refresh();
		}
	}
</script>

<section>
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
	{#if rows.length === 0}
		<p class="meta">No recordings yet.</p>
	{:else}
		<ul aria-label="Recordings">
			{#each rows as row (`${row.where}:${row.id}`)}
				<RecordingRow {row} onchange={refresh} />
			{/each}
		</ul>
	{/if}
</section>
