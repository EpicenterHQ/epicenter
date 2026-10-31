<!--
	The web app's root, which decides the store: the person's `todos`
	repository. Signed in, `Online` sets it for every page under it; signed
	out, a sign-in instead. Todos keeps nothing in the browser (ADR-0700).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import type { Snippet } from 'svelte';
	import { webAuth } from '../auth.js';
	import Online from './Online.svelte';

	let { children }: { children: Snippet } = $props();
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
		<Empty.Title>Todos</Empty.Title>
		<Empty.Description>Sign in to use the todos in your Epicenter repository.</Empty.Description>
		<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
	</Empty.Root>
{/if}
