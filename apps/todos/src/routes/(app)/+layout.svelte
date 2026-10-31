<!--
	Todos' root, which decides the store. In the desktop window it is the
	window's folder (`Desktop`, the page); in a browser it is the person's
	repository: signed in, `Online` sets it for every page under it; signed
	out, a sign-in instead. The sign-in callback is outside this group.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import Online from '$lib/components/Online.svelte';
	import { webAuth } from '$lib/auth.js';

	let { children } = $props();
	// Null in the desktop window, which never signs in.
	const auth = webAuth();

	async function signIn() {
		if (auth === null) return;
		const { error } = await auth.startSignIn();
		if (error !== null)
			toast.error('Could not sign in', { description: error.message });
	}
</script>

{#if auth === null}
	{@render children()}
{:else if auth.state.status !== 'signed-out'}
	{#key auth.state.account}
		<Online account={auth.state.account}>{@render children()}</Online>
	{/key}
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Todos</Empty.Title>
		<Empty.Description>Sign in to use the todos in your Epicenter repository.</Empty.Description>
		<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
	</Empty.Root>
{/if}
