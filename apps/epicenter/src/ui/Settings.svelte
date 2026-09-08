<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import {
		ACCOUNT_CONNECT_ROUTE,
		ACCOUNT_PREPARE_CONNECTION_ROUTE,
		ACCOUNT_CANCEL_CONNECTION_ROUTE,
		ACCOUNT_SELECT_HOSTED_ROUTE,
	} from '../routes.ts';
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
	let server = $state('');
	let token = $state('');
	let connecting = $state(false);
	let connectionError = $state('');
	let choosingServer = $state(false);
	async function connect(path: string, body?: { server: string; token: string }) {
		connecting = true;
		connectionError = '';
		try {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body ?? {}),
			});
			if (!response.ok) throw new Error(await response.text());
			token = '';
			if (path === ACCOUNT_PREPARE_CONNECTION_ROUTE.pattern) {
				choosingServer = true;
				connecting = false;
			}
			if (path === ACCOUNT_CANCEL_CONNECTION_ROUTE.pattern) {
				choosingServer = false;
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
	{#if !choosingServer}
		<div class="grid gap-3 border-b p-3">
			<h2 class="font-medium">Server connection</h2>
			<p class="text-muted-foreground">Close your applications before choosing a server. Epicenter waits for their data to finish saving.</p>
			<Button disabled={connecting} onclick={() => void connect(ACCOUNT_PREPARE_CONNECTION_ROUTE.pattern)}>Close apps and choose server</Button>
			{#if connectionError}<p role="alert" class="text-destructive">{connectionError}</p>{/if}
		</div>
	{:else}
	<form
		class="grid gap-3 border-b p-3"
		onsubmit={(event) => {
			event.preventDefault();
			void connect(ACCOUNT_CONNECT_ROUTE.pattern, { server, token });
		}}
	>
		<h2 class="font-medium">Connect to your server</h2>
		<p class="text-muted-foreground">Epicenter restarts to use the selected server. Your existing local data stays with its original server.</p>
		<Label for="instance-server">Server URL</Label>
		<Input id="instance-server" type="url" required bind:value={server} placeholder="https://your-server.example" disabled={connecting} />
		<Label for="instance-token">Server token</Label>
		<Input id="instance-token" type="password" required bind:value={token} autocomplete="off" disabled={connecting} />
		<div class="flex gap-2">
			<Button type="button" variant="ghost" disabled={connecting} onclick={() => void connect(ACCOUNT_CANCEL_CONNECTION_ROUTE.pattern)}>Cancel</Button>
			<Button type="submit" disabled={connecting}>Connect and restart</Button>
			<Button type="button" variant="outline" disabled={connecting} onclick={() => void connect(ACCOUNT_SELECT_HOSTED_ROUTE.pattern)}>Use Epicenter hosted</Button>
		</div>
		{#if connectionError}<p role="alert" class="text-destructive">{connectionError}</p>{/if}
	</form>
	{/if}
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
