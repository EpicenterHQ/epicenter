<script lang="ts">
	import Settings from './Settings.svelte';
	import { Toaster } from '@epicenter/ui/sonner';

	/**
	 * Settings: the window labelled `home`, beside the applications rather than
	 * a shell above them (ADR-0209).
	 *
	 * Epicenter opens to the Folders window, which lists the folders, the apps
	 * that open them, and every other app; this window holds what the Folders
	 * window does not: host administration, including the account and the
	 * local transcription model (ADR-0180, ADR-0537).
	 */
</script>

<main class="h-full overflow-y-auto text-sm">
	<Settings />
</main>
<Toaster closeButton />
