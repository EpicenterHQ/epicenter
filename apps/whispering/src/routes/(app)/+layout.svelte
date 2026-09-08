<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import RecordingsSession from './_components/RecordingsSession.svelte';

	// This group owns the App; /auth/callback and /recording-overlay open nothing.
	let { children: routeChildren } = $props();
	let session: RecordingsSession | undefined = $state();
</script>

<AppBoot {auth} appName="Whispering" noun="recordings" local close={() => session?.close() ?? Promise.resolve()}>
	{#snippet children(account)}
		<RecordingsSession {account} bind:this={session}>
			{@render routeChildren()}
		</RecordingsSession>
	{/snippet}
</AppBoot>
