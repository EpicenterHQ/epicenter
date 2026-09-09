<script lang="ts">
	import { AppBoot, CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { authStartup } from '$lib/auth.js';
	import { onMount, tick } from 'svelte';
	import VocabShell from './components/VocabShell.svelte';

	let application = $state.raw<typeof import('$lib/application.js')>();
	let error = $state('');
	let showing = $state(true);
	let shell: VocabShell | undefined = $state();
	onMount(() => {
		let stopped = false;
		void import('$lib/application.js').then(async (opened) => {
			if (stopped) { await opened.departure.close(); return; }
			opened.departure.attachUi({
				async quiesce() {
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					const closingUi = shell?.close();
					showing = false;
					await tick();
					await closingUi;
				},
			});
			application = opened;
		}).catch((cause) => { error = cause instanceof Error ? cause.message : 'Could not open Vocab.'; });
		return () => { stopped = true; };
	});
</script>

{#if error}
	<p role="alert">{error}</p>
{:else if application}
	<AppBoot startup={authStartup} departure={application.departure} hasApp={application.app !== null} appName="Vocab" noun="conversations">
		{#if application.app && application.account && showing}
			{#await application.app.ready}
				<Loading class="h-dvh" label="Opening your conversations…" />
			{:then { error }}
				{#if error !== null}
					<CannotOpenScreen appName="Vocab" noun="conversations" {error} retry={() => location.reload()} />
				{:else}
					<VocabShell data={application.app} account={application.account} bind:this={shell} />
				{/if}
			{/await}
		{/if}
	</AppBoot>
{:else}
	<Loading class="h-dvh" label="Opening your conversations…" />
{/if}
