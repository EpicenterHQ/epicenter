<!--
	The local variant (`/`): the recordings in this browser's private files
	(OPFS, `openDevice`, which `main.ts` opens before mounting this), for
	good (ADR-0700). It needs no account and offers
	no sign-in, works offline, and never uploads: the recorder demo has no
	hosted capability, so nothing here signs in. A recording is written into
	those files as it records (`recordInto`); when the page opens, what a
	closed tab cut off is repaired and given its note.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { closeDevice } from '@epicenter/folder/browser';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import { recoverRecordings } from '@epicenter/recorder/browser';
	import Header from './Header.svelte';
	import Recorder from './Recorder.svelte';
	import type { Recorder as RecorderContract } from './contract.ts';
	import { recordInto } from './lib/record.ts';
	import { finishCutOffRecordings } from './lib/recordings.ts';

	// This page's one store: its Worker starts at the first call.
	let { device }: { device: Client<RecorderContract> } = $props();
	onDestroy(() => closeDevice(device));

	// Leaving while a save is out asks first.
	onMount(guardLeave);

	/** Why what a closed tab cut off could not be finished, if it could not. */
	let cutOff = $state<string | null>(null);
	onMount(async () => {
		const repaired = await recoverRecordings({ device, under: 'recordings' });
		// Files this browser will not list (a private window): the list says so.
		if (repaired.error !== null) return;
		const finished = await finishCutOffRecordings(device);
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
		<Recorder client={device} record={recordInto(device)} where="in this browser" />
	</section>
</main>
