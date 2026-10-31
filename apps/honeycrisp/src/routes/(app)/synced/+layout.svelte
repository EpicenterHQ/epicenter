<!--
	The "Synced" pages need the person's repository: signed in, they render
	under the signed-in boundary the root layout adds; signed out, they ask
	for a sign-in instead.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { resolve } from '$app/paths';
	import { webAuth } from '$lib/auth.js';

	let props = $props();
	const auth = webAuth();

	async function signIn() {
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

{#if auth.state.status !== 'signed-out'}
	{@render props.children?.()}
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Synced</Empty.Title>
		<Empty.Description>Sign in to see the notes in your Epicenter repository.</Empty.Description>
		<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
		<Button variant="outline" size="sm" href={resolve('/')}>On this device</Button>
	</Empty.Root>
{/if}
