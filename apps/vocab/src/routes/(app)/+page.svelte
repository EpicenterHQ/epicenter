<!--
	Vocab over its one store, which the variant's root opened: the words,
	chats and messages in the learner's `vocab` repository on the web, where
	every edit is a commit and nothing is kept in the browser, or in the
	desktop window's folder.
-->
<script lang="ts">
	import { store } from '#platform/root';
	import VocabApp from '../components/VocabApp.svelte';

	const vocab = store();
</script>

<VocabApp {vocab} />
