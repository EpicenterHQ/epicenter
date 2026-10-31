<!--
	Vocab's desktop startup (decision 94): the AppData root, then the data
	folder, opened before any page renders, with the shell's answer to who,
	if anyone, is signed in. Until they answer, the layout's boundary shows
	its spinner. Either root that cannot open shows the recovery screen,
	whose actions retry here; otherwise the app runs over them
	(`DesktopRoot`).
-->
<script lang="ts">
	import { vocab } from '../contract.js';
	import { authReady } from '../auth.tauri.js';
	import { openAppData, openDataFolder } from '@epicenter/folder/tauri';
	import Recovery from '@epicenter/svelte/recovery';
	import type { Snippet } from 'svelte';
	import { vocabSettings } from '../folder.tauri.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children }: { children: Snippet } = $props();

	/** Retry counts another attempt; reading it below opens both roots again. */
	let attempt = $state(0);
	const retry = () => attempt++;
	const again = <T,>(_attempt: number, open: () => Promise<T>) => open();
	const opened = () => Promise.all([openAppData(vocabSettings), authReady]).then(([appData]) => appData);

	const appData = $derived(await again(attempt, opened));
	const device = $derived(appData.error === null ? await openDataFolder(vocab, { appData: appData.data }) : null);
</script>

{#if appData.error !== null}
	<Recovery app="Vocab" error={appData.error} {retry} />
{:else if device?.error}
	<Recovery app="Vocab" error={device.error} appData={appData.data} {retry} />
{:else if device !== null}
	<DesktopRoot appData={appData.data} device={device.data}>{@render children()}</DesktopRoot>
{/if}
