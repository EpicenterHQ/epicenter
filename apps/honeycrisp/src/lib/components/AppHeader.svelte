<!--
	The header: the app's name, then the variant's account of the store
	(`Chrome` from `#platform/root`): where the notes are, whether they read,
	and the account on the web or the folder's sync on the desktop.
-->
<script lang="ts">
	import { Chrome } from '#platform/root';
	import { getHoneycrisp } from '$lib/honeycrisp.svelte.js';

	const { notes, folders } = getHoneycrisp();
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>
	<Chrome unreadable={notes.error ?? folders.error} />
</header>
