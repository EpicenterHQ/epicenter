<!--
	The data folder Whispering keeps its recordings in, where the folder is
	on this computer (`folder.reveal`): where it is, and a button that shows
	it. Whispering never syncs it (ADR-0822).
-->
<script lang="ts">
	import FolderOnboarding from '@epicenter/svelte/folder-onboarding';
	import { folder } from '../app.js';

	// `<WhenOpen>` renders the app, and so this, only over the open data folder.
	const path = folder.displayPath() ?? '';
</script>

<section class="flex flex-col gap-2 text-xs" data-testid="desktop-folder">
	<p class="text-sm font-medium">Data folder</p>
	<FolderOnboarding noun="recordings" path={path} pathTestId="desktop-folder-path" />
	<p class="text-muted-foreground">Plain files: a Markdown note per recording beside its audio.</p>
</section>
