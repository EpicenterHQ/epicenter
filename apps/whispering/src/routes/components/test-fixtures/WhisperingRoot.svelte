<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { OpenWhisperingFolder, Workspace } from '../../../lib/workspace/types.js';
	import type { Whispering } from '../../../lib/whispering.svelte.js';
	import type { WhisperingContext } from '../../../lib/folder.js';
	import WhisperingApp from '../WhisperingApp.svelte';
	import WhisperingPage from './WhisperingPage.svelte';

	let { open, workspace, page, report }: {
		open: OpenWhisperingFolder;
		workspace: Workspace;
		page: { route: string };
		report: (whispering: Whispering, context: WhisperingContext) => void;
	} = $props();
</script>

<Tooltip.Provider>
	<FolderApp {open}>
		{#snippet children(context)}
			<WhisperingApp {context} {workspace}>
				{#key page.route}
					<WhisperingPage {report} route={page.route} />
				{/key}
			</WhisperingApp>
		{/snippet}
	</FolderApp>
</Tooltip.Provider>
