<script lang="ts">
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnPrincipalChange } from '@epicenter/svelte/auth';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { auth } from '#platform/auth';
	import { honeycrisp } from '$lib/honeycrisp';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// ADR-0088: the workspace authority is picked once at boot (the branch
	// inside `openHoneycrispBrowser`); a principal identity change reloads so the
	// next boot opens the right local database.
	onMount(() => reloadOnPrincipalChange(auth));
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<WorkspaceGate
	pending={honeycrisp.whenReady}
	onSignOut={() => auth.signOut()}
>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</WorkspaceGate>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
