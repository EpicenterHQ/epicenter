/**
 * The person's choice of where Todos keeps the list in this browser, so a
 * reload reopens it instead of asking again. Only a person's click writes it;
 * Change in the header forgets it.
 */

/** The Local demo, or the signed-in Epicenter account. */
export type StartChoice = 'local' | 'account';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const CHOICE_KEY = 'so.epicenter.todos.start';
/** This tab just connected GitHub; the account screen says so once. */
const CONNECTED_KEY = 'so.epicenter.todos.github-connected';

export function rememberedChoice(
	storage: KeyValueStorage,
): StartChoice | undefined {
	const value = storage.getItem(CHOICE_KEY);
	return value === 'local' || value === 'account' ? value : undefined;
}

export function rememberChoice(
	storage: KeyValueStorage,
	choice: StartChoice | undefined,
) {
	if (choice === undefined) storage.removeItem(CHOICE_KEY);
	else storage.setItem(CHOICE_KEY, choice);
}

/** Note that GitHub was just connected as `login`, for the account screen. */
export function noteConnected(storage: KeyValueStorage, login: string) {
	storage.setItem(CONNECTED_KEY, login);
}

/** The login GitHub was just connected as, read once. */
export function takeConnected(storage: KeyValueStorage): string | undefined {
	const login = storage.getItem(CONNECTED_KEY);
	storage.removeItem(CONNECTED_KEY);
	return login ?? undefined;
}
