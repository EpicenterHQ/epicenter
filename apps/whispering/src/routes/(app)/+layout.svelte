<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { authClient } from '#platform/auth';
	import { onMount, tick } from 'svelte';
	import WhisperingShell from './_components/WhisperingShell.svelte';
	import LibrarySelection from '$lib/components/LibrarySelection.svelte';

	let { children } = $props();
	let application = $state.raw<Awaited<ReturnType<typeof import('$lib/application.js')['openApplication']>>>();
	let error = $state('');
	let showing = $state(true);
	let shell: WhisperingShell | undefined = $state();
	let closeUi: (() => Promise<void>) | undefined;
	onMount(() => {
		let stopped = false;
		void import('$lib/application.js').then(async ({ openApplication }) => {
			if (stopped) return;
			const opened = await openApplication();
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
					closeUi ??= shell?.close;
					const closingUi = closeUi?.();
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
	{#snippet libraryMenu()}
		{#if application}
		<LibrarySelection library={application.library} canOpenShared={application.canOpenShared} select={application.selectLibrary} />
		{/if}
	{/snippet}
	{#if !application.app}<div class="p-3">{@render libraryMenu()}</div>{/if}
	<AppBoot startup={authClient} departure={application.departure} ready={application.app?.ready} appName="Whispering" noun="recordings">
		{#snippet openingFailure()}
			<div class="p-3">{@render libraryMenu()}</div>
		{/snippet}
		{#if application.app && application.selections && showing}
			<WhisperingShell {libraryMenu} selections={application.selections} openedApp={application.app} account={application.account} bind:this={shell}>
				{@render children()}
			</WhisperingShell>
		{/if}
	</AppBoot>
{:else}
	<Loading class="h-dvh" label="Opening your recordings…" />
{/if}
