<!--
	The local variant (`/`): the recordings in this browser's private files
	(OPFS, `openDevice`, which `main.ts` opens before mounting this), for
	good (ADR-0700). It needs no account and offers
	no sign-in, works offline, and never uploads: the recorder demo has no
	hosted capability, so nothing here signs in.
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { closeDevice } from '@epicenter/folder/browser';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import Header from './Header.svelte';
	import Recorder from './Recorder.svelte';
	import type { Recorder as RecorderContract } from './contract.ts';

	// This page's one store: its Worker starts at the first call.
	let { device }: { device: Client<RecorderContract> } = $props();
	onDestroy(() => closeDevice(device));

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

<main>
	<Header variant="local" />
	<section aria-labelledby="local-heading">
		<h2 id="local-heading">On this browser</h2>
		<p class="meta">
			Kept in this browser's files, with no account, online or not. They
			stay here.
		</p>
		<Recorder client={device} where="in this browser" />
	</section>
</main>
