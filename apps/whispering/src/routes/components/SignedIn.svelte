<!--
	Signed in: the person's `whispering` repository beside this browser's
	files, and the uploader that moves what was made here, signed out or
	offline, into the repository (decision 12). Recordings made signed out
	upload to whoever signs in next on this browser (decision 67).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import type { Client } from '@epicenter/definition/contract';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { onDestroy, type Snippet } from 'svelte';
	import { type Whispering, whispering } from '$lib/contract.js';
	import WhisperingApp from './WhisperingApp.svelte';

	// One account for this component's life: the parent's `{#key}` makes a new
	// one for a new account, and sign-out or replacement retires this
	// repository and its uploader.
	const {
		device,
		account,
		children,
	}: { device: Client<Whispering>; account: Account; children: Snippet } = $props();

	// svelte-ignore state_referenced_locally
	const repository = openRemote(whispering, { account });
	// The uploader's writes reach both sides' listeners, so the lists follow it.
	// svelte-ignore state_referenced_locally
	const uploader = startUploading(device, repository);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

<WhisperingApp {device} {repository}>{@render children()}</WhisperingApp>
