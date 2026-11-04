<!--
	The web app's root, which decides the store: the learner's `vocab`
	repository. Signed in, `Online` sets it for every page under it; signed
	out, a sign-in instead. The same sign-in covers the hosted tutor and
	dictation. Vocab keeps none of the learner's words or chats in the browser
	(ADR-0700).
-->
<script lang="ts">
	import { auth } from '#platform/auth';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import type { Snippet } from 'svelte';
	import Online from './Online.svelte';

	let { children }: { children: Snippet } = $props();

	const signIn = $derived(auth.state());

	async function startSignIn() {
		// A successful start leaves this page for the sign-in page.
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}
</script>

{#if signIn.status !== 'signed-out'}
	{#key signIn.account}
		<Online account={signIn.account}>{@render children()}</Online>
	{/key}
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Vocab</Empty.Title>
		<Empty.Description>{auth.purpose.signedOut}</Empty.Description>
		<Button size="sm" onclick={() => void startSignIn()}>Sign in</Button>
	</Empty.Root>
{/if}
