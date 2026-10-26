<!--
	Honeycrisp over its local folder: `<OpenFolder>` opens
	`openFolder({ tables: honeycrispTables })`, shows its loading and refusal
	screens, hands the open folder to `HoneycrispApp`, and closes it when the
	page goes away.
-->
<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { honeycrispTables } from '$lib/data.js';
	import HoneycrispApp from './components/HoneycrispApp.svelte';
</script>

<OpenFolder open={() => openFolder({ tables: honeycrispTables })}>
	{#snippet children(folder)}
		<HoneycrispApp {folder} />
	{/snippet}
</OpenFolder>
