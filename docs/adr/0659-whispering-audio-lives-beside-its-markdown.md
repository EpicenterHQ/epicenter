# 0659. Whispering audio lives beside its Markdown

- **Status:** Accepted
- **Date:** 2026-10-21
- **Related history:** [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) and [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md), both superseded, describe earlier placement and capture decisions. This record replaces the explicit-path convention with a clean break.
- **Amended:** 2026-10-21. The initial implementation retained explicit audio links; the user chose to remove that compatibility path entirely.

## Decision

Whispering's authored folder is a portable recording library: copying the
folder includes original audio alongside its Markdown. Original recordings
remain in this folder rather than app-managed AppData. For now, ordinary
Git commits include only untracked Markdown and ignore files by default;
folder portability and Git synchronization have different inclusion policies.

New captures pair `recordings/<id>.md` with one supported audio file
`recordings/<id>.<extension>`. The capture device chooses the extension from
its actual container. New Markdown stores no `audioPath`; Whispering resolves
the unique supported sibling by exact stem. Multiple matches are reported as
ambiguous and cannot play or transcribe. A missing local audio file does not
make otherwise valid recording metadata malformed.

The same-stem layout is the only recording-audio relationship. The schema
declares no `audioPath`, and no metadata field overrides sibling resolution.
There is no alternate-directory lookup, data-version dispatch, or migration.
Opening leaves existing bytes untouched; recordings without a matching sibling
show missing audio. Native interrupted-WAV recovery checks only `recordings/`.
Audio remains an ordinary authored file; deleting a recording keeps its audio.

Whispering supplies these ordinary root `.gitignore` defaults:

```gitignore
*
!*/
!*.md
!.gitignore
```

By default, Markdown and ignore files remain eligible in nested directories.
Audio, images, PDFs, configuration, and other non-Markdown files stay on disk
but are excluded when untracked. A missing block is inserted before existing
text, after any BOM, so authored rules keep their order and can override the
defaults. A recognized block stays where it is, including one installed at the
end by an earlier build; move that block to the top to restore earlier custom
exclusions. Comments and blank lines do not interrupt block recognition. Merged
text is read again to verify the root block remains present. Later rules and
nested `.gitignore` files determine actual eligibility, and Git still controls
tracked files. This is an app-supplied default, not a permanent privacy boundary.

These rules do not remove audio that Git already tracks or erase it from
earlier commits. Existing tracked audio requires an explicit, separate
decision; opening Whispering never silently untracks or rewrites its history.

## Consequences

The audio and its notes are adjacent without storing a second path that must
agree with the layout. WAV and browser capture containers remain supported.
Copying the complete folder can carry both; a Git clone normally carries
the committed documents without the ignored recordings. Playback on another
device therefore requires a transfer that also includes the original audio.
Transcription resolves siblings from a fresh listing so a stale UI cannot
silently choose the wrong format. Two same-stem audio files need user repair
rather than an arbitrary extension preference.

Git eligibility no longer depends on the recognized audio formats. New audio
formats and other attachments remain local without adding an extension rule.
This deliberately excludes untracked non-Markdown attachments from Git too;
a complete folder copy retains them. No SQLite database or internal namespace
is introduced by this change.
