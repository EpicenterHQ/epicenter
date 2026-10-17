<script lang="ts">
	import { APPS } from '@epicenter/constants/apps';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { vocabFolder } from '$lib/data.js';
	import VocabShell from './components/VocabShell.svelte';

	// Vocab's folder is this browser's own storage, under its app id, with no
	// account and no sign-in: words and chats are there whether or not an
	// account is signed in. Vocab has no desktop build.
	const app = { id: APPS.VOCAB.id, title: 'Vocab' };
</script>

<FolderApp {app} definition={vocabFolder}><VocabShell /></FolderApp>
