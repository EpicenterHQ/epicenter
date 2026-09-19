<script lang="ts">
	import { resolve } from '$app/paths';
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '$lib/auth.js';
	import { vocabDefinition } from '$lib/data.js';
	import VocabShell from './components/VocabShell.svelte';

	const connecting = !auth.getState().account || new URLSearchParams(location.search).has('connect');
</script>

{#if connecting}
	<SignInScreen {auth} appName="Vocab" noun="conversations"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace(resolve('/')) : undefined} />
{:else}
	<AppBoot {auth} definition={vocabDefinition}
		 appName="Vocab" noun="conversations"
		signInHref={location.pathname + '?connect'}
		signedOutHref={resolve('/')}
	>
		{#snippet children(app)}
			<VocabShell data={app} />
		{/snippet}
	</AppBoot>
{/if}
