<script lang="ts">
	import { openFolder } from '@epicenter/folder/next/browser';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { vocabTables } from '$lib/data.js';
	import VocabApp from './components/VocabApp.svelte';

	// Vocab's words and chats are this browser's local folder, with no
	// account and no sign-in: they are there whether or not an account is
	// signed in. Vocab has no desktop build.
</script>

<OpenFolder open={() => openFolder({ tables: vocabTables })}>
	{#snippet children(folder)}
		<VocabApp {folder} />
	{/snippet}
</OpenFolder>
