<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { Button } from '@epicenter/ui/button';
	import { CommandPalette } from '@epicenter/ui/command-palette';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import CaseSensitiveIcon from '@lucide/svelte/icons/case-sensitive';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import RegexIcon from '@lucide/svelte/icons/regex';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WholeWordIcon from '@lucide/svelte/icons/whole-word';
	import XIcon from '@lucide/svelte/icons/x';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import AiDrawer from '$lib/components/AiDrawer.svelte';
	import { createCommandPaletteItems } from '$lib/components/command-palette-items';
	import UnifiedTabList from '$lib/components/tabs/UnifiedTabList.svelte';
	import { tabManagerBoot } from '$lib/session.svelte';
	import { browserState } from '$lib/state/browser-state.svelte';

	const tabManager = tabManagerBoot.tabManager;
	const auth = tabManagerBoot.auth;
	const items = createCommandPaletteItems(tabManager.state.savedTabs);
	let searchInputRef = $state<HTMLInputElement | null>(null);
	let commandPaletteOpen = $state(false);
	let aiDrawerOpen = $state(false);
	let searchFocused = $state(false);
	const isSearchActive = $derived(
		searchFocused || tabManager.state.unifiedView.searchQuery !== '',
	);
	const reauthRequired = $derived(auth.state.status === 'reauth-required');

	let reconnecting = $state(false);
	async function reconnect() {
		reconnecting = true;
		try {
			const { error } = await auth.startSignIn();
			if (error)
				toast.error('Failed to reconnect', { description: error.message });
		} finally {
			reconnecting = false;
		}
	}
</script>

{#snippet searchToggle(pressed: boolean, onPressedChange: (v: boolean) => void, Icon:typeof CaseSensitiveIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Toggle
					size="sm"
					{pressed}
					{onPressedChange}
					aria-label={label}
					class="size-6 rounded-sm p-0"
					{...props}
				>
					<Icon class="size-3.5" />
				</Toggle>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<Tooltip.Provider>
	<main
		class="h-full w-full overflow-hidden flex flex-col bg-background text-foreground"
	>
		<header
			class="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 px-3 py-2"
		>
			{#if reauthRequired}
				<button
					type="button"
					class="mb-2 flex w-full items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-left text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
					onclick={reconnect}
					disabled={reconnecting}
				>
					<span>Session expired. Local edits still work.</span>
					<span class="font-medium underline-offset-2 hover:underline">
						{reconnecting ? 'Reconnecting…' : 'Reconnect'}
					</span>
				</button>
			{/if}
			<div class="flex items-center gap-2">
				<div
					class="relative flex-1"
					onfocusin={() => { searchFocused = true; }}
					onfocusout={(e: FocusEvent) => {
						const container = e.currentTarget as HTMLElement;
						if (container.contains(e.relatedTarget as Node)) return;
						searchFocused = false;
					}}
				>
					<SearchIcon
						class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						bind:ref={searchInputRef}
						type="search"
						placeholder="Search tabs..."
						bind:value={tabManager.state.unifiedView.searchQuery}
						onkeydown={(e: KeyboardEvent) => {
						// "/" in empty input opens command palette
						if (e.key === '/' && tabManager.state.unifiedView.searchQuery === '') {
							e.preventDefault();
							commandPaletteOpen = true;
						}
						// "@" in empty input opens AI drawer (Phase 4)
						if (e.key === '@' && tabManager.state.unifiedView.searchQuery === '') {
							e.preventDefault();
							aiDrawerOpen = true;
						}
						// Escape clears search
						if (e.key === 'Escape') {
							tabManager.state.unifiedView.searchQuery = '';
							searchInputRef?.blur();
						}
					}}
						class={isSearchActive
							? "h-8 pl-8 pr-[7.5rem] text-sm [&::-webkit-search-cancel-button]:hidden"
							: "h-8 pl-8 pr-8 text-sm [&::-webkit-search-cancel-button]:hidden"}
					/>
					{#if isSearchActive}
						<div
							class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
						>
							{#if tabManager.state.unifiedView.searchQuery}
								<button
									type="button"
									class="text-muted-foreground hover:text-foreground"
									onclick={() => {
										tabManager.state.unifiedView.searchQuery = '';
										searchInputRef?.focus();
									}}
								>
									<XIcon class="size-3.5" />
								</button>
							{/if}
							{@render searchToggle(tabManager.state.unifiedView.isCaseSensitive, (v) => { tabManager.state.unifiedView.isCaseSensitive = v; }, CaseSensitiveIcon, 'Match Case')}
							{@render searchToggle(tabManager.state.unifiedView.isRegex, (v) => { tabManager.state.unifiedView.isRegex = v; }, RegexIcon, 'Use Regular Expression')}
							{@render searchToggle(tabManager.state.unifiedView.isExactMatch, (v) => { tabManager.state.unifiedView.isExactMatch = v; }, WholeWordIcon, 'Match Whole Word')}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<button
											type="button"
											class="flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent"
											{...props}
										>
											{({ all: 'All', title: 'Title', url: 'URL' })[tabManager.state.unifiedView.searchField]}
											<ChevronDownIcon class="size-2.5" />
										</button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end" class="w-28">
									<DropdownMenu.RadioGroup
										bind:value={tabManager.state.unifiedView.searchField}
									>
										<DropdownMenu.RadioItem value="all"
											>All Fields</DropdownMenu.RadioItem
										>
										<DropdownMenu.RadioItem value="title"
											>Title Only</DropdownMenu.RadioItem
										>
										<DropdownMenu.RadioItem value="url"
											>URL Only</DropdownMenu.RadioItem
										>
									</DropdownMenu.RadioGroup>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
					{/if}
				</div>
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="Commands"
					onclick={() => {
						commandPaletteOpen = true;
					}}
				>
					<TerminalIcon />
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					tooltip="AI Chat"
					onclick={() => {
						aiDrawerOpen = true;
					}}
				>
					<ZapIcon />
				</Button>
				<AccountPopover
					{auth}
					sync={tabManager.collaboration}
					syncNoun="tabs"
					onForgetDevice={() => tabManager.wipe()}
					instanceConnect={{ appName: 'Epicenter', setting: tabManagerBoot.instanceSetting }}
				/>
			</div>
		</header>
		<!-- Gate on browser state seed so child components can read data synchronously -->
		{#await Promise.all([tabManager.storage.whenLoaded, browserState.whenReady])}
			<Loading class="flex-1" label="Loading tabs…" />
		{:then}
			<div class="flex-1 min-h-0"><UnifiedTabList /></div>
		{:catch}
			<Empty.Root class="flex-1 flex items-center justify-center">
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load tabs</Empty.Title>
				<Empty.Description>
					Something went wrong loading browser state. Try reopening the side
					panel.
				</Empty.Description>
			</Empty.Root>
		{/await}
	</main>
</Tooltip.Provider>
<ConfirmationDialog />
<CommandPalette {items} bind:open={commandPaletteOpen} shortcut={null} />
<AiDrawer bind:open={aiDrawerOpen} />
