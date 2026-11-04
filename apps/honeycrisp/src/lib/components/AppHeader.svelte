<!--
	The header: the app's name, then the build's account of the store
	(`Chrome` from `#platform/chrome`): where the notes are, whether they
	read, and the account on the web or the folder's sync on the desktop.
-->
<script lang="ts">
	import Chrome from '#platform/chrome';
	import { folder } from '$lib/app.js';
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold">Honeycrisp</h1>
	<Chrome unreadable={folder.notes.error() ?? folder.folders.error()} />
</header>
