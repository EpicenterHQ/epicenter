/** What the shell loads: the opener and every bundle it can install, each app's module included. `bundle.test.ts` bundles this the way the build resolves it. */

export * as files from '@epicenter/files/bundle';
export * as honeycrisp from '@epicenter/honeycrisp/bundle';
export { openBrowserRepository } from '@epicenter/repository/browser';
export * as todos from '@epicenter/todos/bundle';
export { FIRST_PARTY } from './catalog.js';
