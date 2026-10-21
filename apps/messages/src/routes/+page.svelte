<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { messagesTables } from '$lib/definition.js';
	import MessagesApp from '$lib/MessagesApp.svelte';
</script>

<FolderApp open={() => openFolder({ tables: messagesTables })}>
	{#snippet children(context)}<MessagesApp {context} />{/snippet}
</FolderApp>
