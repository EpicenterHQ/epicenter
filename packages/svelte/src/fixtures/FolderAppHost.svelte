<!-- `<FolderApp>` over the test's opener, handing its opened context to the test. -->
<script lang="ts">
	import type { Folder, OpenFolderError } from '@epicenter/folder';
	import type { TSchema } from 'typebox';
	import type { Result } from 'wellcrafted/result';
	import FolderApp from '../folder-app.svelte';
	import type { FolderContext } from '../folder-context.js';
	import ContextProbe from './ContextProbe.svelte';

	let {
		open,
		onContext,
	}: {
		open: () => Promise<Result<Folder<Record<string, TSchema>>, OpenFolderError>>;
		onContext: (context: FolderContext) => void;
	} = $props();
</script>

<FolderApp {open}>
	{#snippet children(context)}<ContextProbe {context} {onContext} />{/snippet}
</FolderApp>
