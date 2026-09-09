<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import {
		ACCOUNT_CONNECT_ROUTE,
		ACCOUNT_CANCEL_CONNECTION_ROUTE,
		ACCOUNT_USE_CLOUD_ROUTE,
		ACCOUNT_SIGN_IN_ROUTE,
		ACCOUNT_SIGN_OUT_ROUTE,
	} from '../routes.ts';
	import { auth as startup } from './auth.js';
	import { isDesktopHost } from './runtime.ts';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { WHISPERING_APPLICATION } from '../applications.ts';
	import { createLaunch } from './launch.svelte.ts';
	import LocalModelAdministration from './LocalModelAdministration.svelte';
	import { localModels } from './local-models.svelte';

	/**
	 * Host-level administration (ADR-0189) includes the cloud connection and local
	 * transcription model (ADR-0180), which lives here rather than in the shell
	 * header: choosing what every application on this device transcribes with is
	 * a settings act, not a conversation control.
	 *
	 * The choice names files and an accelerator on this machine, so a browser or
	 * remote Home says where it lives instead of offering controls that would
	 * reach the wrong device.
	 */

	const launcher = createLaunch();
	let server = $state(startup.selectedServer ?? '');
	let connecting = $state(false);
	let connectionError = $state('');
	let changingServer = $state(false);
	async function connect(path: string, body: object = {}) {
		connecting = true;
		connectionError = '';
		try {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!response.ok) throw new Error(await response.text());
			if (path === ACCOUNT_CANCEL_CONNECTION_ROUTE.pattern || path === ACCOUNT_SIGN_IN_ROUTE.pattern) {
				connecting = false;
			}
			// A selected connection stays pending until native replaces this process.
		} catch (cause) {
			connectionError =
				cause instanceof Error ? cause.message : 'Could not connect.';
			connecting = false;
		}
	}

	/**
	 * Whether local transcription can actually run now: a model is chosen and its
	 * files are on this device.
	 *
	 * This is the condition for the shortcut below, and it is deliberately a
	 * statement about the host rather than about who is reading it. Nothing
	 * records that the user arrived from Whispering (ADR-0189), so the shortcut
	 * is offered on the same terms to someone who set a model up on their own.
	 */
	const isLocalTranscriptionReady = $derived(
		localModels.active !== null && localModels.active.installed,
	);
</script>

{#if isDesktopHost()}
	<div class="grid gap-3 border-b p-3">
		<h2 class="font-medium">Account</h2>
		{#if startup.auth === null}
			<p role="alert">Your saved server choice could not be read. Choose a server to continue. Your local data is still on this device.</p>
		{:else}
			<p>{startup.selectedServer === null ? 'Epicenter Cloud' : 'Your server'}: {startup.auth.state.status === 'signed-out' ? 'Signed out' : 'Signed in'}</p>
			{#if startup.selectedServer !== null}<p class="break-all text-sm text-muted-foreground">{startup.selectedServer}</p>{/if}
		{/if}
		<p class="text-muted-foreground">Changing accounts closes your applications and restarts Epicenter. Your existing local data stays with its original server.</p>
		<Button disabled={connecting} onclick={() => void connect(startup.auth?.startSignIn !== undefined ? ACCOUNT_SIGN_IN_ROUTE.pattern : ACCOUNT_USE_CLOUD_ROUTE.pattern)}>
			{startup.auth?.startSignIn !== undefined ? 'Sign in' : 'Use Epicenter Cloud'}
		</Button>
		{#if startup.selectedServer !== null && startup.auth?.startSignIn}
			<Button variant="outline" disabled={connecting} onclick={() => void connect(ACCOUNT_USE_CLOUD_ROUTE.pattern)}>Use Epicenter Cloud</Button>
		{/if}
		{#if startup.auth && startup.auth.state.status !== 'signed-out'}
			<Button variant="outline" disabled={connecting} onclick={() => void connect(ACCOUNT_SIGN_OUT_ROUTE.pattern)}>Sign out</Button>
		{/if}
	</div>
	<form
		class="grid gap-3 border-b p-3"
		onsubmit={(event) => {
			event.preventDefault();
			void connect(ACCOUNT_CONNECT_ROUTE.pattern, { server: startup.selectedServer !== null && !changingServer ? startup.selectedServer : server });
		}}
	>
		<h2 class="font-medium">Connect to your server</h2>
		{#if startup.selectedServer !== null}
			<Button type="button" variant="ghost" disabled={connecting} onclick={() => changingServer = !changingServer}>{changingServer ? 'Keep current server' : 'Change server'}</Button>
		{/if}
		<Label for="instance-server">Server URL</Label>
		<Input id="instance-server" type="url" required bind:value={server} placeholder="https://your-server.example" readonly={startup.selectedServer !== null && !changingServer} disabled={connecting} />
		<div class="flex gap-2">
			<Button type="submit" disabled={connecting}>Connect and restart</Button>
		</div>
		{#if connectionError}
			<p role="alert" class="text-destructive">{connectionError}</p>
			<Button type="button" variant="ghost" disabled={connecting} onclick={() => void connect(ACCOUNT_CANCEL_CONNECTION_ROUTE.pattern)}>Return to saved connection</Button>
		{/if}
	</form>
{/if}

{#if localModels.available}
	<div class="grid gap-3 p-3">
		<LocalModelAdministration />

		{#if isLocalTranscriptionReady}
			<!-- The ordinary launch action, not a return path: it states what is
			     true of the host, and the user chooses. Same row shape as the Apps
			     pane, because it is the same act. -->
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Description>
						Local transcription is ready on this device.
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Button
						variant="outline"
						size="sm"
						onclick={() => void launcher.launch(WHISPERING_APPLICATION)}
					>
						Open {WHISPERING_APPLICATION.title}
					</Button>
				</Item.Actions>
			</Item.Root>
		{/if}

		{#if launcher.failure}
			<Alert.Root variant="destructive">
				<Alert.Title>Could not open</Alert.Title>
				<Alert.Description>{launcher.failure}</Alert.Description>
			</Alert.Root>
		{/if}
	</div>
{:else}
	<Empty.Root class="h-full border-0">
		<Empty.Header>
			<Empty.Title>Settings live on the desktop</Empty.Title>
			<Empty.Description>
				Choosing the local transcription model needs the model files and the
				hardware on the machine running Epicenter, so it happens there.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{/if}
