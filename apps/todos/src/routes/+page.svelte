<!--
	The root: Todos over this page's device, always there (decision 10).
	Signed in (the web build only), the signed-in boundary adds the person's
	repository, one per account.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import { webAuth } from '$lib/auth.js';

	const auth = webAuth();
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth === null || auth.state.status === 'signed-out'}
	<TodosApp signedIn={false} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}><TodosApp signedIn /></SignedIn>
	{/key}
{/if}
