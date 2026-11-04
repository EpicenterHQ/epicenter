<!--
	The local variant (`/`): the recordings in this browser's private files
	(OPFS, the folder `lib/local.ts` opens), for good (ADR-0700). When they
	cannot open, it says why instead of the recorder. It needs no account and offers
	no sign-in, works offline, and never uploads: the recorder demo has no
	hosted capability, so nothing here signs in. A recording is written into
	those files as it records (`recordInto`); when the page opens, what a
	closed tab cut off is repaired and given its note.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { recorder } from '@epicenter/recorder/browser';
	import Header from './Header.svelte';
	import Recorder from './Recorder.svelte';
	import { folder } from './lib/local.ts';
	import { recordInto } from './lib/record.ts';
	import { finishCutOffRecordings, unnamedAudio } from './lib/recordings.ts';

	const opened = $derived(folder.state());

	/** Why what a closed tab cut off could not be finished, if it could not. */
	let cutOff = $state<string | null>(null);
	onMount(async () => {
		const unnamed = await unnamedAudio(folder);
		// Files this browser will not list (a private window): the list says so.
		if (unnamed.error !== null) return;
		const repaired = await recorder.recover({
			folder,
			under: 'recordings',
			unnamed: unnamed.data,
		});
		if (repaired.error !== null) return;
		const finished = await finishCutOffRecordings(folder);
		if (finished.error !== null) cutOff = finished.error;
	});
</script>

<main>
	<Header variant="local" />
	<section aria-labelledby="local-heading">
		<h2 id="local-heading">On this browser</h2>
		<p class="meta">
			Kept in this browser's files, with no account, online or not. They
			stay here.
		</p>
		{#if cutOff}
			<p class="problem" role="alert">
				Recordings a closed tab cut off could not be finished: {cutOff}
			</p>
		{/if}
		{#if opened.status === 'failed'}
			<p class="problem" role="alert">
				The recorder could not open this browser's files: {opened.error.message}
			</p>
		{:else}
			<Recorder {folder} record={recordInto(folder)} where="in this browser" />
		{/if}
	</section>
</main>
