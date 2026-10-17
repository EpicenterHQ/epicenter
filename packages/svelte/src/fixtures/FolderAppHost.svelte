<!--
	A folder app's root for mounted tests: `<FolderApp>` over a test folder,
	a child that reads the opened folder with `getFolder()`, and the toaster
	the app layout mounts.
-->
<script lang="ts">
	import type { BrowserFolderOptions, Definition } from '@epicenter/folder';
	import { Toaster } from '@epicenter/ui/sonner';
	import FolderApp from '../folder-app.svelte';
	import type { FolderContext } from '../folder-context.js';
	import FolderChild from './FolderChild.svelte';

	let {
		app,
		definition,
		browser,
		onFolder,
	}: {
		app: { id: string; title: string };
		definition: Definition;
		browser?: BrowserFolderOptions;
		onFolder: (context: FolderContext) => void;
	} = $props();
</script>

<FolderApp {app} {definition} {browser}><FolderChild {onFolder} /></FolderApp>
<Toaster />
