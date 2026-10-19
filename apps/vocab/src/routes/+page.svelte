<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import { vocabTables } from '$lib/data.js';
	import VocabShell from './components/VocabShell.svelte';

	// Vocab's words and chats are this browser's local folder, with no
	// account and no sign-in: they are there whether or not an account is
	// signed in. Vocab has no desktop build.
</script>

<FolderApp title="Vocab" tables={vocabTables}><VocabShell /></FolderApp>
