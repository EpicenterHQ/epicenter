<!--
	Honeycrisp over its one store: the notes and folders in the person's
	`honeycrisp` repository, which the signed-in layout set. Every edit is a
	commit there; nothing is kept in the browser.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import type { Honeycrisp } from '$lib/contract.js';
</script>

<HoneycrispApp client={fromClient(getRepo<Honeycrisp>())} />
