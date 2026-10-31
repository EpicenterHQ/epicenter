<!--
	Vocab's root, which decides the store (decision 78): the variant's
	`Startup` (`#platform/root`) opens it before any page under it renders,
	and the boundary shows the UI kit's spinner until it has. The web app's is
	the learner's `vocab` repository behind sign-in; the desktop window's is
	the folder Vocab keeps its words and chats in. The sign-in callback is
	outside this group, so it opens nothing (ADR-0345).
-->
<script lang="ts">
	import { Startup } from '#platform/root';
	import { Loading } from '@epicenter/ui/loading';

	let { children } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<Loading class="h-dvh" />
	{/snippet}
	<Startup>{@render children()}</Startup>
</svelte:boundary>
