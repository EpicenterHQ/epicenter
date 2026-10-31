<!--
	Vocab's root, which decides the store: the learner's `vocab` repository.
	Signed in, `Online` sets it for every page under it; signed out, a sign-in
	instead. The same sign-in covers the hosted tutor and dictation. Vocab
	keeps none of the learner's words or chats in the browser (ADR-0700). The
	sign-in callback is outside this group, so it opens nothing (ADR-0345).
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { auth } from '$lib/auth.svelte.js';
	import Online from '../components/Online.svelte';

	let { children } = $props();

	async function signIn() {
		// A successful start leaves this page for the sign-in page.
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
		<Empty.Title>Vocab</Empty.Title>
		<Empty.Description>Sign in to use the words and chats in your Epicenter repository.</Empty.Description>
		<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
	</Empty.Root>
{/if}
