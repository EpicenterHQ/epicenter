<!--
	Whispering's desktop startup (decision 94): the AppData root, then the
	data folder, opened before any page renders. Until both answer, the
	layout's boundary shows its spinner. Either root that cannot open shows
	the recovery screen, whose actions retry here; otherwise the app runs
	over the data folder (`DesktopRoot`, then `children`).
-->
<script lang="ts">
	import type { Client } from '@epicenter/definition/contract';
	import { openAppData, openDataFolder } from '@epicenter/folder/tauri';
	import type { ReactiveClient } from '@epicenter/svelte/client';
	import Recovery from '@epicenter/svelte/recovery';
	import type { Snippet } from 'svelte';
	import { type Whispering, whispering } from '../contract.js';
	import { whisperingSettings } from '../settings.tauri.js';
	import DesktopRoot from './DesktopRoot.svelte';

	let { children: outer }: { children: Snippet<[Client<Whispering>, ReactiveClient<Whispering>]> } = $props();

	/** Retry counts another attempt; reading it below opens both roots again. */
	let attempt = $state(0);
	const retry = () => attempt++;
	const again = <T,>(_attempt: number, open: () => Promise<T>) => open();

	const appData = $derived(await again(attempt, () => openAppData(whisperingSettings)));
	const device = $derived(appData.error === null ? await openDataFolder(whispering, { appData: appData.data }) : null);
</script>

{#if appData.error !== null}
	<Recovery app="Whispering" error={appData.error} {retry} />
{:else if device?.error}
	<Recovery app="Whispering" error={device.error} appData={appData.data} {retry} />
{:else if device !== null}
	<DesktopRoot appData={appData.data} device={device.data}>
		{#snippet children(files)}
			{@render outer(device.data, files)}
		{/snippet}
	</DesktopRoot>
{/if}
