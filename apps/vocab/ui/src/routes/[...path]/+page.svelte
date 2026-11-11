<!--
	One word's page, at the word's path: `#/data/words/你好.md`. Keyed by the path
	so each word gets its own page.
-->
<script lang="ts">
	import { page } from '$app/state';
	import WordPage from '$lib/WordPage.svelte';
</script>

{#key page.params.path}
	<WordPage path={page.params.path ?? ''} />
{/key}
