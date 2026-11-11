<!--
	One book's page, at the book's path: `#/data/books/Dune.md`. Keyed by the path
	so each book gets its own page.
-->
<script lang="ts">
	import { page } from '$app/state';
	import BookPage from '$lib/BookPage.svelte';
</script>

{#key page.params.path}
	<BookPage path={page.params.path ?? ''} />
{/key}
