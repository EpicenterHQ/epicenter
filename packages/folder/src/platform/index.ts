/**
 * `@epicenter/folder/platform`: the record Epicenter keeps of a folder it
 * syncs (`FolderRecord`), which `syncedRecord` in `@epicenter/folder/tauri`
 * answers for the app's data folder. The platform operations of the retired
 * folder sync product (ADR-0899) are at the git tag `folder-sync-product`.
 */
export type { FolderRecord } from './records.js';
