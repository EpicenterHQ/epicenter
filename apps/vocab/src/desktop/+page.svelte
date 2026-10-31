<!--
	The desktop program's one view: the same Vocab as the web build, over the
	folder the shell bound to this window (`$lib/desktop/device.ts`), with
	the folder's menu where the web links its views. Signing in or out
	remounts it, as on the web: the account adds hosted models only.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { auth } from '$lib/auth.svelte.js';
	import FolderMenu from '$lib/desktop/FolderMenu.svelte';
	import { device } from '$lib/desktop/device.js';
	import VocabApp from '../routes/components/VocabApp.svelte';
</script>

{#key auth.state.account}
	<VocabApp view="folder" vocab={fromClient(device)}>
		{#snippet views()}<FolderMenu />{/snippet}
	</VocabApp>
{/key}
