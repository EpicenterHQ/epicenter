<script lang="ts">
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { authStartup } from '$lib/auth.js';
	import { vocabDefinition } from '$lib/data.js';
	import VocabShell from './components/VocabShell.svelte';

	const auth = authStartup.auth ?? undefined;
	const connecting = !auth?.getState().account || new URLSearchParams(location.search).has('connect');
	let shell: VocabShell | undefined = $state();
</script>

{#if connecting}
	<SignInScreen {auth} selection={authStartup} appName="Vocab" noun="conversations"
		onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace('/') : undefined} />
{:else}
	<AppBoot {auth} definition={vocabDefinition} selection={authStartup}
		ui={shell} appName="Vocab" noun="conversations">
		{#snippet children(app)}
			<VocabShell data={app} bind:this={shell} />
		{/snippet}
	</AppBoot>
{/if}
