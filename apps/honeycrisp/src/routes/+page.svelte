<script lang="ts">
	import { AppBoot } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { authStartup } from '#platform/auth';
	import { onMount, tick } from 'svelte';
	import StoreShell from './components/StoreShell.svelte';
	import LibrarySelection from './components/LibrarySelection.svelte';

	let application = $state.raw<typeof import('$lib/application.js')>();
	let error = $state('');
	let showing = $state(true);
	onMount(() => {
		let stopped = false;
		void import('$lib/application.js').then(async (opened) => {
			if (stopped) { await opened.departure.close(); return; }
			opened.departure.attachUi({
				async quiesce() {
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					showing = false;
					await tick();
				},
			});
			application = opened;
		}).catch((cause) => { error = cause instanceof Error ? cause.message : 'Could not open Honeycrisp.'; });
		return () => { stopped = true; };
	});
</script>

{#if error}
	<p role="alert">{error}</p>
{:else if application}
	{#snippet librarySelection()}
		{#if application}
			<LibrarySelection library={application.library} canOpenShared={application.canOpenShared} select={application.selectLibrary} />
		{/if}
	{/snippet}
	{#if !application.app}
		<div class="fixed left-4 top-4 z-10">{@render librarySelection()}</div>
	{/if}
	<AppBoot startup={authStartup} departure={application.departure} ready={application.app?.ready} appName="Honeycrisp" noun="notes">
		{#snippet openingFailure()}
			<div class="fixed left-4 top-4 z-10">{@render librarySelection()}</div>
		{/snippet}
		{#if application.app && showing}
			<StoreShell data={application.app} {librarySelection} />
		{/if}
	</AppBoot>
{:else}
	<Loading class="h-dvh" label="Opening your notes…" />
{/if}
