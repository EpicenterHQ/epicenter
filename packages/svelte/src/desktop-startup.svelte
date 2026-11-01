<!--
	A standalone desktop app's startup (decision 94): the AppData root, then
	the data folder, opened before any page renders. Until both answer (and
	`ready`, when given), the layout's boundary shows its spinner. Either
	root that cannot open shows the recovery screen (`Recovery`), whose
	actions retry here; otherwise `children` renders over both clients.

	```svelte
	<DesktopStartup app="Capture" settings={desktopSettings} contract={capture}>
		{#snippet children(appData, device)}
			<DesktopRoot {appData} {device}>{@render pages()}</DesktopRoot>
		{/snippet}
	</DesktopStartup>
	```
-->
<script
	lang="ts"
	generics="TSettings extends SettingsContract, TContract extends Contract"
>
	import type { Client, Contract } from '@epicenter/definition/contract';
	import {
		type FolderSettings,
		openAppData,
		openDataFolder,
		type SettingsContract,
	} from '@epicenter/folder/tauri';
	import type { Snippet } from 'svelte';
	import Recovery from './recovery.svelte';

	let {
		app,
		settings,
		contract,
		ready,
		children,
	}: {
		/** The app's name, as people know it (`Capture`). */
		app: string;
		/** The AppData root's contract, which names the data folder. */
		settings: TSettings;
		/** The data folder's contract. */
		contract: TContract;
		/** Anything else the first page waits for, such as the shell's sign-in answer. */
		ready?: Promise<unknown>;
		/** The app over its open roots. */
		children: Snippet<[Client<TSettings>, Client<TContract>]>;
	} = $props();

	/** Retry counts another attempt; reading it below opens both roots again. */
	let attempt = $state(0);
	const retry = () => attempt++;
	const again = <T,>(_attempt: number, open: () => Promise<T>) => open();
	const opened = () =>
		Promise.all([openAppData(settings), ready]).then(([appData]) => appData);
	// SAFETY: a settings contract's `settings` collection is the
	// `settings.md` note; TypeScript does not resolve a client's
	// note-or-file type over a type parameter.
	const folderOf = (client: Client<TSettings>) => client as unknown as FolderSettings;

	const appData = $derived(await again(attempt, opened));
	const device = $derived(appData.error === null ? await openDataFolder(contract, { appData: folderOf(appData.data) }) : null);
</script>

{#if appData.error !== null}
	<Recovery {app} error={appData.error} {retry} />
{:else if device?.error}
	<Recovery {app} error={device.error} appData={folderOf(appData.data)} {retry} />
{:else if device !== null}
	{@render children(appData.data, device.data)}
{/if}
