<!--
	Vocab over its one store: the words, chats and messages in the learner's
	`vocab` repository, which the signed-in layout set. Every edit is a commit
	there; nothing is kept in the browser.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import type { Vocab } from '$lib/contract.js';
	import VocabApp from '../components/VocabApp.svelte';
</script>

<VocabApp vocab={fromClient(getRepo<Vocab>())} />
