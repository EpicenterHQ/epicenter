<!--
	The root: Vocab over this browser's files (OPFS, `$lib/device.ts`),
	always there with no sign-in in front of them (decision 10). Signed in,
	the signed-in boundary adds the learner's `vocab` repository, one per
	account, and uploads what was made here.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import { auth } from '$lib/auth.svelte.js';
	import SignedIn from './components/SignedIn.svelte';
	import VocabApp from './components/VocabApp.svelte';

	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	<VocabApp account={undefined} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}><VocabApp account={auth.state.account} /></SignedIn>
	{/key}
{/if}
