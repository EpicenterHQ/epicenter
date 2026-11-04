<!--
	A standalone desktop app's startup (decision 94): an optional AppData root, then
	the data folder, opened before any page renders. Until both answer (and
	`ready`, when given), the layout's boundary shows its spinner. Either
	root that cannot open shows the recovery screen (`Recovery`), whose
	actions retry here; otherwise `children` renders over both clients.

	```svelte
	<DesktopStartup app="Capture" contract={capture} site={APPS.CAPTURE.url}>
		{#snippet children(_appData, device, site)}
			<DesktopRoot {device} {site}>{@render pages()}</DesktopRoot>
		{/snippet}
	</DesktopStartup>
	```
-->
<script
	lang="ts"
	generics="TSettings extends Contract, TContract extends Contract"
>
	import type { Client, Contract } from '@epicenter/definition/contract';
	import {
		openAppData,
		openDataFolder,
		revealRoot,
	} from '@epicenter/folder/tauri';
	import type { Snippet } from 'svelte';
	import Recovery from './recovery.svelte';

	let {
		app,
		settings,
		contract,
		site,
		ready,
		children,
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** The optional machine-local settings contract. */
		settings?: TSettings;
		/** The data folder's contract. */
		contract: TContract;
		/** The app's production site. */
		site: string;
		/** Anything else the first page waits for, such as the shell's sign-in answer. */
		ready?: Promise<unknown>;
		/** The app over its open roots. */
		children: Snippet<[Client<TSettings> | undefined, Client<TContract>, string]>;
	} = $props();

	/** Retry counts another attempt; reading it below opens both roots again. */
	let attempt = $state(0);
	const retry = () => attempt++;
	const again = <T,>(_attempt: number, open: () => Promise<T>) => open();
	const opened = () =>
		Promise.all([settings === undefined ? undefined : openAppData(settings), ready])
			.then(([appData]) => appData);
	const appData = $derived(await again(attempt, opened));
	const device = $derived(
		appData === undefined || appData.error === null
			? await again(attempt, () => openDataFolder(contract, site))
			: null,
	);
</script>

{#if appData?.error}
	<Recovery {app} error={appData.error} appDataError {retry} reveal={() => revealRoot('AppData')} />
{:else if device?.error}
	<Recovery {app} error={device.error} {retry} reveal={() => revealRoot('Data')} />
{:else if device !== null}
	{@render children(appData?.data, device.data, site)}
{/if}
