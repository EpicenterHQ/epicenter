<script lang="ts">
	import OpenFolder from '@epicenter/svelte/open-folder';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Opened } from '@epicenter/folder';
	import type { Whispering } from '../../../lib/whispering.svelte.js';
	import type { WhisperingTables } from '../../../lib/definition.js';
	import type { WhisperingFolder } from '../../../lib/folder.js';
	import WhisperingApp from '../WhisperingApp.svelte';
	import WhisperingPage from './WhisperingPage.svelte';

	let { open, page, report }: {
		open: () => Opened<WhisperingTables>;
		page: { route: string };
		report: (whispering: Whispering, folder: WhisperingFolder) => void;
	} = $props();
</script>

<Tooltip.Provider>
	<OpenFolder {open}>
		{#snippet children(folder)}
			<WhisperingApp {folder}>
				{#key page.route}
					<WhisperingPage {report} route={page.route} />
				{/key}
			</WhisperingApp>
		{/snippet}
	</OpenFolder>
</Tooltip.Provider>
