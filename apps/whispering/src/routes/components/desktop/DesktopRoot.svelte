<!--
	The root of every page of Whispering's desktop app (`#platform/desktop`).
	The shell asked on first run where to keep the files and bound that
	folder to this window before the page loaded (`epicenter-standalone`), so
	the page opens it as Whispering's client and renders the same app as the
	browser over it (decision 78). Closing the window waits for the saves in
	flight (the leave guard).

	Decision 82 has the page open a second device, the app's machine-local
	`settings.md` (`openDevice(appConfig, { path: <config dir> })`), once the
	folder plugin grants a window that directory beside its folder. The shell
	keeps the one setting there today (`folder`), so nothing here reads it yet.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { openDevice } from '@epicenter/folder/tauri';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { onMount, type Snippet } from 'svelte';
	import { whispering } from '$lib/contract.js';
	import { folderPath } from '$lib/platform/shell.tauri.js';
	import DesktopApp from './DesktopApp.svelte';

	let { children }: { children: Snippet } = $props();

	// The window's folder holds for its life: another folder is another window.
	const device = openDevice(whispering);
	const folder = folderPath();

	onMount(guardLeave);
</script>

{#await folder}
	<Loading class="h-dvh" label="Opening your folder…" />
{:then folder}
	<DesktopApp {folder} {device}>{@render children()}</DesktopApp>
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Whispering could not open its folder</Empty.Title>
			<Empty.Description role="alert">{extractErrorMessage(error)}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/await}
