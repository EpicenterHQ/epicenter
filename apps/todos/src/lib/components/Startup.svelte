<!--
	Todos' desktop startup: its two roots (`DesktopStartup`), then the app
	over them (`DesktopRoot`).
-->
<script lang="ts">
	import DesktopStartup from '@epicenter/svelte/desktop-startup';
	import { APPS } from '@epicenter/constants/apps';
	import type { Snippet } from 'svelte';
	import { todos } from '../contract.js';
		import DesktopRoot from './DesktopRoot.svelte';

	let { children: pages }: { children: Snippet } = $props();
</script>

<DesktopStartup app="Todos" contract={todos} site={APPS.TODOS.url}>
	{#snippet children(_appData, device, site)}
		<DesktopRoot {device} {site}>{@render pages()}</DesktopRoot>
	{/snippet}
</DesktopStartup>
