/**
 * Bun First-Attachment Conformance Tests
 *
 * Binds the shared first-attachment crash and reopen cases to the production
 * Bun SQLite replica adapter.
 *
 * Key behaviors:
 * - Bring is atomic and preserves scalar, document, and blob obligations
 * - Discard is atomic and leaves one permanently attached empty replica
 * - A kill immediately after commit reopens the complete committed outcome
 */
import { runAttachmentConformanceCases } from './attachment-cases.test-support.js';
import { bunAttachmentBinding } from './bun-replica.test-support.js';

runAttachmentConformanceCases(bunAttachmentBinding);
