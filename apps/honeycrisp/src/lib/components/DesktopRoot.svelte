<!--
	The desktop window's root, which decides the store: the folder Honeycrisp
	keeps its notes in, `~/Epicenter/Honeycrisp` unless the person chose another,
	set for every page under it. When it cannot be opened, it says why and
	offers Retry, Choose folder…, and Use the default folder.
-->
<script lang="ts">
	import { honeycrisp } from '../contract.js';
	import DataFolder from '@epicenter/svelte/data-folder';
	import type { Snippet } from 'svelte';
	import { desktop } from '../folder.tauri.js';

	let { children }: { children: Snippet } = $props();
</script>

<DataFolder app="Honeycrisp" contract={honeycrisp} {desktop} kept="Each note is a Markdown file in this folder.">{@render children()}</DataFolder>
