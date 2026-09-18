/**
 * The desktop host serves this build from the one loopback origin and owns
 * `~/Epicenter`, so the checkout route is same-origin and reachable
 * (ADR-0337).
 *
 * The seam hands over the capability rather than a flag saying it exists. A
 * boolean meant every build constructed the folder verbs and then decided
 * whether to show a button; a build with no filesystem now has no working copy
 * to construct, and the components that take one are unreachable from it.
 */
export { createWorkingCopy as openWorkingCopy } from '@epicenter/app/artifact/checkout';
