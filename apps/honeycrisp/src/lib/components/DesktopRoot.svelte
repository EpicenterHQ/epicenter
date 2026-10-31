<!--
	The desktop window's root, which decides the store: the folder Honeycrisp
	keeps its notes in, set for every page under it. Until the person chooses
	where that is, or when the remembered folder could not be opened, it asks.
-->
<script lang="ts">
	import ChooseFolder from '@epicenter/svelte/choose-folder';
	import { setRepo } from '@epicenter/svelte/repo';
	import type { Snippet } from 'svelte';
	import { device, folder } from '../folder.tauri.js';

	let { children }: { children: Snippet } = $props();

	if (device !== null) setRepo(device);
</script>

{#if device === null}
	<ChooseFolder app="Honeycrisp" {folder} kept="Each note is a Markdown file in this folder." />
{:else}
	{@render children()}
{/if}
