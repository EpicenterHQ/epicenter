<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { auth } from '$lib/auth';
	import ConversationsSession from './components/ConversationsSession.svelte';

	// The callback is a sibling: it never mounts this App or its connection screen.
	let session: ConversationsSession | undefined = $state();
</script>

<AppBoot {auth} appName="Vocab" noun="conversations" close={() => session?.close() ?? Promise.resolve()}>
	{#snippet children(account)}
		{#if account}<ConversationsSession {account} bind:this={session} />{/if}
	{/snippet}
</AppBoot>
