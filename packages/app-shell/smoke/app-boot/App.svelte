<script lang="ts">
	import { openLocal } from '@epicenter/app/open';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import AppBoot from '../../src/boot-screens/app-boot.svelte';
	import SignInScreen from '../../src/boot-screens/sign-in-screen.svelte';
	import Session from './Session.svelte';
	import { auth, definition, runtime } from './application.js';
	const connecting =
		new URL(location.href).searchParams.has('connect') &&
		!new URL(location.href).searchParams.has('stopped');
	const open =
		connecting || new URL(location.href).searchParams.has('stopped')
			? undefined
			: () => openLocal(definition, { runtime });
</script>
<Tooltip.Provider>
{#if connecting}
 <SignInScreen {auth} appName="Probe" noun="changes" onCancel={() => location.replace('/')} />
{:else}
 <AppBoot {auth} signInHref="/apps/probe/sign-in?connect" signedOutHref="/apps/probe/signed-out?connect" {open}
   appName="Probe" noun="changes">
  {#snippet children(app)}<Session {app} />{/snippet}
 </AppBoot>
{/if}

</Tooltip.Provider>
<Toaster />
<ConfirmationDialog />
