<script lang="ts">
	import { getWhisperingApp } from '$lib/whispering/context';
	const app = getWhisperingApp();
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { useSidebar } from '@epicenter/ui/sidebar';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { toggleMode } from 'mode-watcher';
	import { page } from '$app/state';
	import { GithubIcon } from '$lib/components/icons';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import { NAV_ITEMS } from './nav-items';
	import { auth } from '#platform/auth';
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { recordingActive } from '$lib/state/recording-active.svelte';

	let {
		removeLocalData,
	}: {
		/** See `WhisperingShell`. Absent means the popover offers sign-out only. */
		removeLocalData?: () => Promise<void>;
	} = $props();

	const sidebar = useSidebar();
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
				>
					{#snippet child({ props })}
						<button {...props} onclick={sidebar.toggle}>
							<div
								class="bg-sidebar-accent flex size-8 items-center justify-center rounded-lg"
							>
								<img src={studioMicrophone} alt="" class="size-4" />
							</div>
							<div
								class="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden"
							>
								<span class="truncate font-semibold">Whispering</span>
								<span class="truncate text-xs text-muted-foreground"
									>Speech to text</span
								>
							</div>
						</button>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<!-- Navigation Group -->
		<Sidebar.Group>
			<Sidebar.GroupLabel>Navigation</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each NAV_ITEMS as item}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={item.isActive(page.url.pathname)}>
								{#snippet child({ props })}
									{@const Icon = item.icon}
									<a href={item.href} {...props}>
										<Icon />
										<span>{item.label}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Footer>
		<Sidebar.Menu>
			<!-- Account / sync (route-independent: visible on the bare home page) -->
			<Sidebar.MenuItem>
				<!-- `onRemoveLocalData` is passed only where the platform can remove
			     one account's audio and leave another's. In the browser build the
			     audio is the account's own IndexedDB database,
			     `epicenter/<app-id>/accounts/<authority-id>/<principal-id>/blobs` (ADR-0349), and the
			     session component erases it right after the generations. The
			     desktop leaf exports no erase: the host keeps one flat
			     `<root>/blobs` behind `/api/local-blobs` for everybody who has
			     ever signed in on this machine, keyed by nothing, so removing the
			     replica there would delete the recordings and leave their audio
			     behind. What the desktop half still needs is a principal segment
			     in the Bun store's root, an authenticated route to reach it, and
			     the WebView adapter for that route. Until then the desktop popover
			     offers sign-out only, and the recordings are still safe at the
			     account. -->
				<AccountPopover
					{auth}
					syncNoun="recordings"
					onRemoveLocalData={removeLocalData}
					disabledReason={recordingActive(app)
						? 'Stop recording to change your account'
						: undefined}
				/>
			</Sidebar.MenuItem>

			<!-- Toggle dark mode -->
			<Sidebar.MenuItem>
				<Sidebar.MenuButton>
					{#snippet child({ props })}
						<button onclick={toggleMode} {...props}>
							<SunIcon
								class="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
							/>
							<MoonIcon
								class="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
							/>
							<span>Toggle theme</span>
						</button>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>

			<!-- GitHub link -->
			<Sidebar.MenuItem>
				<Sidebar.MenuButton>
					{#snippet child({ props })}
						<a
							href="https://github.com/EpicenterHQ/epicenter"
							target="_blank"
							rel="noopener noreferrer"
							{...props}
						>
							<GithubIcon />
							<span>GitHub</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>

	<Sidebar.Rail />
</Sidebar.Root>
