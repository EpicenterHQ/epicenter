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

	async function stop() {
		if (!recording) return;
		busy = true;
		try {
			const { bytes, ext, durationMs } = await recording.stop();
			const recordedAt = new Date();
			const saved = await saveRecording(device, {
				id: timeId(recordedAt),
				title: `Recording ${recordedAt.toLocaleString()}`,
				recordedAt: recordedAt.toISOString(),
				durationMs,
				ext,
				bytes,
			});
			if (saved.error !== null) problem = saved.error.message;
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
