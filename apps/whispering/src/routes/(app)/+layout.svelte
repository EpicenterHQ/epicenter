<script lang="ts">
	import { AppBoot, CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { authClient } from '#platform/auth';
	import { onMount, tick } from 'svelte';
	import WhisperingShell from './_components/WhisperingShell.svelte';

	let { children } = $props();
	let application = $state.raw<typeof import('$lib/application.js')>();
	let error = $state('');
	let showing = $state(true);
	let shell: WhisperingShell | undefined = $state();
	onMount(() => {
		let stopped = false;
		void import('$lib/application.js').then(async (opened) => {
			if (stopped) { await opened.departure.close(); return; }
			opened.departure.attachUi({
				async preflight() {
					if (!opened.app) return;
					const ready = await opened.app.ready;
					if (ready.error) return;
					if (shell) await shell.preflight();
					else {
						const recovered = await opened.app.recording.current();
						if (recovered.error) throw recovered.error;
						if (recovered.data) throw new Error('Finish recording before closing Whispering.');
					}
				},
				async quiesce() {
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					const closingUi = shell?.close();
					showing = false;
					await tick();
					await closingUi;
				},
			});
			application = opened;
		}).catch((cause) => { error = cause instanceof Error ? cause.message : 'Could not open Whispering.'; });
		return () => { stopped = true; };
	});
</script>

{#if error}
	<p role="alert">{error}</p>
{:else if application}
	<AppBoot auth={authClient} departure={application.departure} hasApp={application.app !== null} appName="Whispering" noun="recordings">
		{#if application.app && showing}
			{#await application.app.ready}
				<Loading class="h-dvh" label="Opening your recordings…" />
			{:then { error }}
				{#if error !== null}
					<CannotOpenScreen appName="Whispering" noun="recordings" {error} retry={() => location.reload()} />
				{:else}
					<WhisperingShell openedApp={application.app} account={application.account} bind:this={shell}>
						{@render children()}
					</WhisperingShell>
				{/if}
			{/await}
		{/if}
	</AppBoot>
{:else}
	<Loading class="h-dvh" label="Opening your recordings…" />
{/if}
