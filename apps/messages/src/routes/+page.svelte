<script lang="ts">
	import { openFolder } from '@epicenter/folder/next';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { messagesTables } from '$lib/definition.js';
	import MessagesApp from '$lib/MessagesApp.svelte';
</script>

<OpenFolder open={() => openFolder({ tables: messagesTables })}>
	{#snippet children(folder)}<MessagesApp {folder} />{/snippet}
</OpenFolder>
