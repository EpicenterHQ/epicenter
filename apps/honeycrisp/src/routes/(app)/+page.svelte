<!--
	Honeycrisp over its one store, which the variant's root opened: the notes
	and folders in the person's `honeycrisp` repository on the web, where
	every edit is a commit and nothing is kept in the browser, or in the
	desktop window's folder.
-->
<script lang="ts">
	import { store } from '#platform/root';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';

	const client = store();
</script>

<HoneycrispApp {client} />
