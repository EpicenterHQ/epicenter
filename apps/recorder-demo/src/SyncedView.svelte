<!--
	"Synced" (decision 76): the recordings in the repository the signed-in
	boundary set (`getRepo`), the account's own or one shared with it. Edits
	here write to the repository. A recording this device uploaded plays
	from the device's cache of its audio, with no download.
-->
<script lang="ts">
	import { getRepo } from '@epicenter/svelte/repo';
	import Library from './Library.svelte';
	import type { Recorder } from './contract.ts';
</script>

<Library client={getRepo<Recorder>()} cached />
