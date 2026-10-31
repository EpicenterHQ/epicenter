<!--
	The online variant's signed-in layout: signed in, the person's
	`honeycrisp` repository for every page under it (`Online`); signed out, a
	sign-in instead.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { resolve } from '$app/paths';
	import Online from '$lib/components/Online.svelte';
	import { webAuth } from '$lib/auth.js';

	let { children } = $props();
	const auth = webAuth();

	async function signIn() {
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

{#if auth.state.status !== 'signed-out'}
	{#key auth.state.account}
		<Online account={auth.state.account}>{@render children()}</Online>
	{/key}
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Honeycrisp online</Empty.Title>
		<Empty.Description>Sign in to use the notes in your Epicenter repository.</Empty.Description>
		<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
		<Button variant="outline" size="sm" href={resolve('/')} data-sveltekit-reload>On this browser</Button>
	</Empty.Root>
{/if}
