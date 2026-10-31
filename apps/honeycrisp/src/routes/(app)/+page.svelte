<!--
	Honeycrisp over its one store, which the variant's root set: the notes
	and folders in the person's `honeycrisp` repository on the web, where
	every edit is a commit and nothing is kept in the browser, or in the
	desktop window's folder.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import type { Honeycrisp } from '$lib/contract.js';
</script>

<HoneycrispApp client={fromClient(getRepo<Honeycrisp>())} />
