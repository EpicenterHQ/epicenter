/*
	Installed from @ieedan/shadcn-svelte-extras
*/

import { Context } from 'runed';
import { MediaQuery } from 'svelte/reactivity';

class ModalRootState {
	get view() {
		return this.#isDesktop.current ? 'desktop' : 'mobile';
	}

	#isDesktop = new MediaQuery('(min-width: 768px)');
}

const ctx = new Context<ModalRootState>('modal-root-state');

export function useModal() {
	return ctx.set(new ModalRootState());
}

export function useModalSub() {
	return ctx.get();
}
