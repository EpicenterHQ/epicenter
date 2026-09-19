<script lang="ts">
	import { resolve } from '$app/paths';
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import { onDestroy, tick } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { auth } from '#platform/auth';
	import { whisperingDefinition } from '$lib/data.js';
	import WhisperingShell from './_components/WhisperingShell.svelte';
	import LibrarySelection from '$lib/components/LibrarySelection.svelte';

	let { children: routeChildren } = $props();
	let departingHref = $state<string | undefined>();
	let destroyed = false;
	onDestroy(() => { destroyed = true; });
	const params = new URLSearchParams(location.search);
	const connecting = !params.has('stopped') && params.has('connect');
	const library = (() => {
		if (!auth.getState().account) return 'local';
		const saved = localStorage.getItem('whispering.library');
		return saved === 'local' ? 'local' : 'personal';
	})();
	async function selectLibrary(next: typeof library) {
		if (next === library) return;
		if (!connecting) {
			const confirmed = await new Promise<boolean>((resolve) => {
				confirmationDialog.open({
					title: 'Change library?',
					description: 'Changing libraries will close this page. Active recordings and unsaved work will be discarded.',
					confirm: { text: 'Continue', variant: 'destructive' },
					onConfirm: () => resolve(true),
					onCancel: () => resolve(false),
				});
			});
			if (!confirmed || destroyed) return;
		}
		localStorage.setItem('whispering.library', next);
		departingHref = location.pathname + (!auth.getState().account && next !== 'local' ? '?connect' : '');
		const stopped = new URL(location.href);
		stopped.searchParams.set('stopped', '');
		history.replaceState(history.state, '', stopped);
		await tick();
		if (destroyed) return;
		location.assign(departingHref);
	}

</script>

{#snippet libraryMenu()}
	<LibrarySelection {library} select={selectLibrary} />
{/snippet}

{#if departingHref}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		<p>Opening your selected library…</p>
		<Button onclick={() => location.assign(departingHref!)}>Open library</Button>
	</div>
{:else if connecting}
	<div class="p-3">{@render libraryMenu()}</div>
	<SignInScreen {auth} appName="Whispering" noun="recordings"
		onCancel={() => location.replace(location.pathname)} />
{:else}
	<AppBoot {auth} definition={whisperingDefinition}
		appName="Whispering" noun="recordings"
		signInHref={location.pathname + '?connect'}
		signedOutHref={resolve('/')}
	>
		{#snippet openingFailure()}
			<div class="p-3">{@render libraryMenu()}</div>
		{/snippet}
		{#snippet children(app, account)}
			{#snippet menu()}{@render libraryMenu()}{/snippet}
			{@const data = library === 'local' ? app.device : app.account?.personal}
			{#if data}
				<WhisperingShell libraryMenu={menu} openedApp={app} {data} {account}>
					{@render routeChildren()}
				</WhisperingShell>
			{:else}
				<div class="p-3">{@render menu()}<p>Sign in to use this library.</p></div>
			{/if}
		{/snippet}
	</AppBoot>
{/if}
