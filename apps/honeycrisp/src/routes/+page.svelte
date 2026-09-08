<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import NotesSession from './components/NotesSession.svelte';

	// The callback is a sibling: it never mounts this App or its connection screen.
	let session: NotesSession | undefined = $state();
</script>

<AppBoot {auth} appName="Honeycrisp" noun="notes" close={() => session?.close() ?? Promise.resolve()}>
	{#snippet children(account)}
		{#if account}<NotesSession {account} bind:this={session} />{/if}
	{/snippet}
</AppBoot>
