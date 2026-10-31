/**
 * Vocab's sign-in with Epicenter, chosen by the build (`#platform/auth`):
 * in the browser, one OAuth sign-in for the API and the learner's
 * repository (`platform/auth.browser.ts`); in the desktop program, a
 * sign-in through the system browser for hosted models only, held by its
 * native shell (`platform/auth.tauri.ts`).
 */
export { auth } from '#platform/auth';
