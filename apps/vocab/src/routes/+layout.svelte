<script lang="ts">
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnPrincipalChange } from '@epicenter/svelte/auth';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { auth } from '$lib/platform/auth';
	import { vocab } from '$lib/vocab';
	import '../app.css';

	let { children } = $props();

	// ADR-0088: the workspace authority is picked once at boot (the branch
	// inside `openVocabBrowser`); a principal identity change reloads so the next
	// boot opens the right local database.
	onMount(() => reloadOnPrincipalChange(auth));
</script>

<svelte:head><title>Vocab</title></svelte:head>

<WorkspaceGate
	pending={vocab.whenReady}
	onSignOut={() => auth.signOut()}
>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</WorkspaceGate>

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
<FlushEditsOnHide />
