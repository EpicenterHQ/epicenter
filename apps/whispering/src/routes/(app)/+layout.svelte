<!--
	Whispering's root over its folder and this computer's settings
	(ADR-0766, ADR-0778): `<WhenOpen>` shows a spinner while they connect,
	Recovery when they cannot, and the app once both have, and asks before
	the page is left while a save is out. Where the folder is the person's
	repository (ADR-0786), a signed-out page asks to sign in instead; a
	folder on this computer (`folder.reveal`) needs no sign-in. The sign-in
	callback is outside this group.
-->
<script lang="ts">
	import WhenOpen from '@epicenter/svelte/when-open';
	import type { Snippet } from 'svelte';
	import { account, folder, settings } from '$lib/app.js';
	import SignIn from '$lib/components/SignIn.svelte';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();
</script>

{#if folder.reveal === null && account.state().status === 'signed-out'}
	<SignIn />
{:else}
	<WhenOpen app="Whispering" {folder} {settings}>
		<WhisperingApp>{@render children()}</WhisperingApp>
	</WhenOpen>
{/if}
