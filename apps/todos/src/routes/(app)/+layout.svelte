<!--
	Todos' root over its folder (ADR-0766): `<WhenOpen>` shows a spinner while
	the folder opens, Recovery when it cannot, and the pages once it has, and
	asks before the page is left while a save is out. On the web the folder
	is the signed-in person's repository, so a signed-out page asks to sign
	in instead. The sign-in callback is outside this group.
-->
<script lang="ts">
	import WhenOpen from '@epicenter/svelte/when-open';
	import { account, folder } from '$lib/app.js';
	import SignIn from '$lib/components/SignIn.svelte';

	let { children } = $props();
</script>

{#if account?.getState().status === 'signed-out'}
	<SignIn {account} />
{:else}
	<WhenOpen app="Todos" {folder}>{@render children()}</WhenOpen>
{/if}
