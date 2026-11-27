/*
	Installed from @ieedan/shadcn-svelte-extras
	Modified to support injectable copy function
*/

import type { Snippet } from 'svelte';
import type {
	ButtonProps,
	ButtonSize,
	ButtonVariant,
} from '../button/index.js';
import type { UseClipboard } from '../hooks/use-clipboard.svelte.js';

export type CopyFn = (text: string) => Promise<void>;

export type CopyButtonPropsWithoutHTML = {
	ref?: HTMLButtonElement | null;
	text: string;
	icon?: Snippet<[]>;
	animationDuration?: number;
	onCopy?: (status: UseClipboard['status']) => void;
	/** Custom copy function for cross-platform support. Defaults to navigator.clipboard.writeText. */
	copyFn?: CopyFn;
	size?: ButtonSize;
	variant?: ButtonVariant;
	children?: Snippet<[]>;
};

export type CopyButtonProps = CopyButtonPropsWithoutHTML &
	Omit<ButtonProps, 'children' | 'href' | 'ref' | 'size' | 'variant'>;
