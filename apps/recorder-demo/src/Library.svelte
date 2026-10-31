<script lang="ts">
	import { timeId } from '@epicenter/definition/ids';
	import { cacheOf } from '@epicenter/folder/browser';
	import RecordingRow from './RecordingRow.svelte';
	import { getDevice, type Side } from './lib/context.ts';
	import { startRecording } from './lib/record.ts';
	import { type Cached, mergeRecordings } from './lib/recordings.ts';
	import { saveRecording } from './lib/save.ts';
	import { openMicrophone } from './lib/microphone.ts';

	const { remote }: { remote: Side | null } = $props();

	const device = getDevice();
	const cache = cacheOf(device.client);

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

	/**
	 * Signed in, the audio this account's uploads cached on the device. The
	 * cache is outside the contract, so it is read again whenever either
	 * side's audio changes: an upload caches its audio, then lets go of the
	 * device's copy.
	 */
	let cached = $state.raw<{ items: Cached[]; problem: string | null }>({
		items: [],
		problem: null,
	});
	$effect(() => {
		if (remote === null) return;
		void [device.files.audio.items, remote.files.audio.items];
		let current = true;
		void cache.list().then((listed) => {
			if (!current) return;
			cached = {
				items: (listed.data?.items ?? []).flatMap((file) =>
					file.collection === 'audio' ? [{ id: file.id, ext: file.ext }] : [],
				),
				problem: listed.error?.message ?? null,
			};
		});
		return () => {
			current = false;
		};
	});

	/** The repository's listing, or null when it cannot be listed (offline). */
	const repository = $derived(
		remote === null ||
			remote.files.recordings.error !== null ||
			remote.files.audio.error !== null
			? null
			: { notes: remote.files.recordings.items, audio: remote.files.audio.items },
	);
	const rows = $derived(
		mergeRecordings(
			{ notes: device.files.recordings.items, audio: device.files.audio.items },
			repository,
			remote === null ? [] : cached.items,
		),
	);
	/** Why a side could not be read; the rows still show what was. */
	const unreadable = $derived(
		[
			device.files.recordings.error,
			device.files.audio.error,
			remote?.files.recordings.error,
			remote?.files.audio.error,
		].find((error) => error)?.message ??
			(remote === null ? null : cached.problem),
	);

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
		const saved = await saveRecording(device.client, finished);
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

<section>
	<p class="row">
		{#if recording}
			<button onclick={stop} disabled={busy}>Stop</button>
			<span class="meta">Recording…</span>
		{:else}
			<button onclick={record} disabled={busy}>Record</button>
		{/if}
	</p>
	{#if problem ?? unreadable}
		<p class="problem" role="alert">{problem ?? unreadable}</p>
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
				<RecordingRow {row} />
			{/each}
		</ul>
	{/if}
</section>
