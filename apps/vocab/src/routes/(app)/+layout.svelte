<!--
	Vocab's root over its folder and this computer's settings (ADR-0766,
	ADR-0778): `<WhenOpen>` shows a spinner while they connect, Recovery
	when they cannot, and the pages once both have, and asks before the page
	is left while a save is out. On the web the
	folder is the learner's repository, so a signed-out page asks to sign in
	instead (`accountPurpose.required`); the desktop window's folder needs no
	sign-in. The sign-in callback is outside this group, so it opens nothing
	(ADR-0345).
-->
<script lang="ts">
	import { accountPurpose } from '#platform/account';
	import WhenOpen from '@epicenter/svelte/when-open';
	import { account, folder, settings } from '$lib/app.js';
	import SignIn from '$lib/components/SignIn.svelte';

	let { children } = $props();
</script>

{#if accountPurpose.required && account.state().status === 'signed-out'}
	<SignIn />
{:else}
	<WhenOpen app="Vocab" {folder} {settings}>{@render children()}</WhenOpen>
{/if}
