<!--
	"Synced": Whispering over the person's repository (decision 76). Signed
	in, these pages render under the signed-in boundary the root adds;
	signed out, they ask for a sign-in instead. The root renders this layout
	anew when sign-in starts or ends, so what it reads here holds for its
	life.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { getAuth } from '#platform/auth';
	import WhisperingView from '../components/WhisperingView.svelte';

	let { children }: { children: Snippet } = $props();
	const auth = getAuth();

	async function signIn() {
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

{#if auth.state.status !== 'signed-out'}
	<WhisperingView view="synced">{@render children()}</WhisperingView>
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Synced</Empty.Title>
		<Empty.Description>Sign in to see the recordings in your Epicenter repository.</Empty.Description>
		<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
		<Button variant="outline" size="sm" href={resolve('/')}>On this device</Button>
	</Empty.Root>
{/if}
