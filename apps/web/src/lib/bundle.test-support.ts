/** What the shell loads: the opener and every bundle it can install, each app's module included. `bundle.test.ts` bundles this the way the build resolves it. */
export { openBrowserRepository } from '@epicenter/repository/browser';
export { FIRST_PARTY } from './catalog.js';
export * as todos from '@epicenter/todos/bundle';
export * as honeycrisp from '@epicenter/honeycrisp/bundle';
