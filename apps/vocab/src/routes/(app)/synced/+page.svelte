<!--
	"Synced": the words and chats in the learner's `vocab` repository, through
	the repository the signed-in boundary set (decision 76). Edits here write
	to the repository; this browser's own are on the "On this device" page.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import type { Vocab } from '$lib/contract.js';
	import VocabApp from '../../components/VocabApp.svelte';
	import ViewLinks from '../ViewLinks.svelte';
</script>

<VocabApp view="synced" vocab={fromClient(getRepo<Vocab>())}>
	{#snippet views()}<ViewLinks view="synced" />{/snippet}
</VocabApp>
