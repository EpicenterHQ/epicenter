<script lang="ts">
	import { useQueryClient } from '@tanstack/svelte-query';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';
	import { exposeDebugCommands } from '../_app-effects/expose-debug-commands';
	import { listenForLocalShortcuts } from '../_app-effects/listen-for-local-shortcuts';
	import { logAppStarted } from '../_app-effects/log-app-started';
	import { notifyDictationFailures } from '../_app-effects/notify-dictation-failures.svelte';
	import { reconcileBackups } from '../_app-effects/reconcile-backups';
	import { synchronizeAutoPasteIntent } from '../_app-effects/synchronize-auto-paste-intent.svelte';
	import { synchronizeShortcuts } from '../_app-effects/synchronize-shortcuts';

	// Headless component: mounts Whispering's page-lifetime listeners and
	// reactive projections once, at the session root outside the responsive nav
	// branch, so crossing a layout breakpoint never re-runs any of them. Each
	// helper registers its own lifecycle with Svelte; any required teardown is
	// scoped to this component through $effect cleanup or onMount unmount.
	const app = getWhisperingApp();
	const queryClient = useQueryClient();
	void app.recordings.audioReady.then(() => {
		void queryClient.invalidateQueries({ queryKey: ['audio', 'availability'] });
		void queryClient.invalidateQueries({ queryKey: ['audio', 'unclaimed'] });
	});
	reconcileBackups(app);
	exposeDebugCommands(app);
	logAppStarted(app);
	listenForLocalShortcuts(app);
	synchronizeShortcuts(app);
	notifyDictationFailures();
	synchronizeAutoPasteIntent(app);
	dictationCapability.track();
</script>
