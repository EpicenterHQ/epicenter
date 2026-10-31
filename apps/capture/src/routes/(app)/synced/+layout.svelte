<!--
	The "Synced" pages need the person's repository: signed in, they render
	under the signed-in boundary the root layout adds; signed out, they ask
	for a sign-in instead. The desktop window keeps its captures in its own
	folder, so it has no "Synced" page.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { webAuth } from '#platform/auth';
	import { resolve } from '$app/paths';

	let { children } = $props();
	const auth = webAuth();

	async function signIn() {
		if (auth === null) return;
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

{#if auth !== null && auth.state.status !== 'signed-out'}
	{@render children?.()}
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Synced</Empty.Title>
		{#if auth === null}
			<Empty.Description>This window keeps its captures in Capture's folder on this computer. Sync with Epicenter to keep them in your repository too.</Empty.Description>
		{:else}
			<Empty.Description>Sign in to see the captures in your Epicenter repository.</Empty.Description>
			<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
		{/if}
		<Button variant="outline" size="sm" href={resolve('/')}>On this device</Button>
	</Empty.Root>
{/if}
