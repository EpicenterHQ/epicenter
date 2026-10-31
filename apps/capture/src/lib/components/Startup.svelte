<!--
	Capture's desktop startup (decision 94): the AppData root, then the data
	folder, opened before any page renders. Until both answer, the layout's
	boundary shows its spinner. Either root that cannot open shows the
	recovery screen, whose actions retry here; otherwise the app runs over
	them (`DesktopRoot`).
-->
<script lang="ts">
	import { capture } from '@epicenter/capture';
	import { openAppData, openDataFolder } from '@epicenter/folder/tauri';
	import Recovery from '@epicenter/svelte/recovery';
	import type { Snippet } from 'svelte';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children }: { children: Snippet } = $props();

	/** Retry counts another attempt; reading it below opens both roots again. */
	let attempt = $state(0);
	const retry = () => attempt++;
	const again = <T,>(_attempt: number, open: () => Promise<T>) => open();

	const appData = $derived(await again(attempt, openAppData));
	const device = $derived(appData.error === null ? await openDataFolder(capture, { appData: appData.data }) : null);
</script>

{#if appData.error !== null}
	<Recovery app="Capture" error={appData.error} {retry} />
{:else if device?.error}
	<Recovery app="Capture" error={device.error} appData={appData.data} {retry} />
{:else if device !== null}
	<DesktopRoot appData={appData.data} device={device.data}>{@render children()}</DesktopRoot>
{/if}
