<script lang="ts">
	import { AppBoot, SignInScreen } from '@epicenter/app-shell/boot-screens';
	import type { Departure } from '@epicenter/app-shell/departure';
	import { auth, serverSelection } from '#platform/auth';
	import { whisperingDefinition } from '$lib/data.js';
	import WhisperingShell from './_components/WhisperingShell.svelte';
	import LibrarySelection from '$lib/components/LibrarySelection.svelte';

	let { children: routeChildren } = $props();
	const connecting = !auth || new URLSearchParams(location.search).has('connect');
	const library = (() => {
		if (!auth?.getState().account) return 'local';
		const saved = localStorage.getItem('whispering.library');
		if (saved === null) return 'personal';
		if (saved === 'local' || saved === 'personal' || saved === 'shared') return saved;
		throw new Error('Your saved library choice could not be read.');
	})();
	let shell: WhisperingShell | undefined = $state();
	function selectLibrary(next: typeof library, leave?: Departure['go']) {
		if (next === library) return Promise.resolve();
		const navigate = () => {
			localStorage.setItem('whispering.library', next);
			location.assign(location.pathname + (!auth?.getState().account && next !== 'local' ? '?connect' : ''));
		};
		if (leave) return leave(navigate);
		navigate();
		return Promise.resolve();
	}
</script>

{#snippet libraryMenu(leave?: Departure['go'])}
	<LibrarySelection {library} canOpenShared={auth?.getState().account?.supportsShared ?? false} select={(next) => selectLibrary(next, leave)} />
{/snippet}

{#if connecting}
	<div class="p-3">{@render libraryMenu()}</div>
	<SignInScreen {auth} selection={serverSelection} appName="Whispering" noun="recordings"
		onCancel={() => location.replace(location.pathname)} />
{:else}
	<AppBoot {auth} definition={whisperingDefinition} selection={serverSelection} ui={shell}
		appName="Whispering" noun="recordings">
		{#snippet openingFailure()}
			<div class="p-3">{@render libraryMenu()}</div>
		{/snippet}
		{#snippet children(app, leave, account)}
			{#snippet menu()}{@render libraryMenu(leave)}{/snippet}
			{@const data = library === 'local' ? app.device : library === 'personal' ? app.account?.personal : app.account?.shared}
			{#if data}
				<WhisperingShell libraryMenu={menu} openedApp={app} {data} {account} bind:this={shell}>
					{@render routeChildren()}
				</WhisperingShell>
			{:else}
				<div class="p-3">{@render menu()}<p>Sign in to use this library.</p></div>
			{/if}
		{/snippet}
	</AppBoot>
{/if}
