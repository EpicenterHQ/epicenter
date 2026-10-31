/**
 * `@epicenter/folder/outbox`: what a device client carries besides its
 * collections, for code that works over any device whichever opener made it
 * (`/browser`, `/tauri`, `/node`), without loading an opener: its outbox
 * of captures to upload, and its compiled contract.
 */
export { compiledContractOf, outboxOf } from './device/outbox.js';
