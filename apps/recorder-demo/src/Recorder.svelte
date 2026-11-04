<!--
	The recorder over one folder, this browser's files for the page's life,
	read through `reactive`: Record and Stop, and below them the folder's
	recordings (`Library`). A recording is written into the folder as it
	records (`recorder.start`, decision 84): each piece of audio, about a
	second, is appended to `recordings/{id}.{ext}` as it arrives, so a closed
	tab keeps it, and only the note waits for Stop, since the contract
	requires its length. While one of the folder's writes is out, leaving
	the page asks first.
-->
<script lang="ts">
	import { timeId } from '@epicenter/definition/ids';
	import type { Folder } from '@epicenter/folder/core';
	import { type Recording, recorder } from '@epicenter/recorder/browser';
	import LeaveGuard from '@epicenter/svelte/leave-guard';
	import Library from './Library.svelte';
	import type { Recorder } from './contract.ts';

	const {
		folder: files,
	}: {
		/** The folder recordings are written to and listed from, as `reactive` adapts it; fixed for the component's life. */
		folder: Folder<Recorder>;
	} = $props();

	let problem = $state<string | null>(null);
	let recording = $state<{ id: string; at: Date; take: Recording } | null>(
		null,
	);
	let busy = $state(false);

	async function record() {
		problem = null;
		busy = true;
		try {
			const at = new Date();
			const id = timeId(at);
			const started = await recorder.start({
				folder: files,
				path: `recordings/${id}`,
			});
			if (started.error !== null)
				problem = `Could not start recording: ${started.error.message}`;
			else recording = { id, at, take: started.data };
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
			// The audio is at its path; its note follows. A note that does not
			// land leaves the audio listed, and the next page open names it.
			const title = `Recording ${at.toLocaleString()}`;
			const note = await files.recordings.create({
				id,
				title,
				recordedAt: at.toISOString(),
				durationMs: stopped.data.durationMs,
			});
			if (note.error !== null)
				problem = `${title} is kept, but its note was not saved: ${note.error.message}`;
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
<Library {files} />

<LeaveGuard folder={files} />
