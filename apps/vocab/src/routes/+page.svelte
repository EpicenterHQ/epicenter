<script lang="ts">
	import { resolve } from '$app/paths';
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '$lib/auth.js';
	import { openVocabResources } from '$lib/resources.js';
	import VocabShell from './components/VocabShell.svelte';

	const params = new URLSearchParams(location.search);
	const connecting =
		!params.has('stopped') && (!auth.getState().account || params.has('connect'));
	const account = auth.getState().account;
	const open =
		!connecting && account && !new URLSearchParams(location.search).has('stopped')
			? (signal: AbortSignal) => openVocabResources(account, signal)
			: undefined;
</script>

{#if connecting}
	<SignInScreen {auth} appName="Vocab" noun="entries"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace(resolve('/')) : undefined} />
{:else}
	<AppBoot {auth} {open}
		 appName="Vocab" noun="entries"
		signInHref={location.pathname + '?connect'}
		signedOutHref={resolve('/')}
	>
		{#snippet children(app)}
			<VocabShell data={app} />
		{/snippet}
	</AppBoot>
{/if}
