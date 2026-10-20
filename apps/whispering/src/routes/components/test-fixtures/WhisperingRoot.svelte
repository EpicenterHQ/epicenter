<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Whispering } from '../../../lib/whispering.svelte.js';
	import type { OpenFolderError } from '@epicenter/folder';
	import type { Result } from 'wellcrafted/result';
	import type { WhisperingFolder, WhisperingContext } from '../../../lib/folder.js';
	import WhisperingApp from '../WhisperingApp.svelte';
	import WhisperingPage from './WhisperingPage.svelte';

	let { open, page, report }: {
		open: () => Promise<Result<WhisperingFolder, OpenFolderError>>;
		page: { route: string };
		report: (whispering: Whispering, context: WhisperingContext) => void;
	} = $props();
</script>

<Tooltip.Provider>
	<FolderApp {open}>
		{#snippet children(context)}
			<WhisperingApp {context}>
				{#key page.route}
					<WhisperingPage {report} route={page.route} />
				{/key}
			</WhisperingApp>
		{/snippet}
	</FolderApp>
</Tooltip.Provider>
