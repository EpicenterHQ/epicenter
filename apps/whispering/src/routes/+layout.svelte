<!--
	Every page of Whispering: the chrome. The app is the `(app)` group at `/`,
	whose layout opens the store (`folder` from `src/lib/app.ts`: the person's
	repository in a browser, the data folder in a Tauri window) and guards leaving while it saves
	(`<WhenOpen>`); the sign-in callback is outside it and reads no files.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	{@render props.children?.()}
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
