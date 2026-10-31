<!--
	The desktop window's root, which decides the store: the folder Capture
	keeps its files in, `~/Epicenter/Capture` unless the person chose another,
	set for every page under it. When it cannot be opened, it says why and
	offers Retry, Choose folder…, and Use the default folder.
-->
<script lang="ts">
	import { capture } from '@epicenter/capture';
	import DataFolder from '@epicenter/svelte/data-folder';
	import type { Snippet } from 'svelte';
	import { desktop } from '../folder.tauri.js';

	let { children }: { children: Snippet } = $props();
</script>

<DataFolder app="Capture" contract={capture} {desktop} kept="Each capture is a Markdown file in this folder.">{@render children()}</DataFolder>
