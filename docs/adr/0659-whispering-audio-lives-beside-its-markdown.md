# 0659. Whispering audio lives beside its Markdown

- **Status:** Accepted
- **Date:** 2026-10-21
- **Related history:** [ADR-0577](0577-audio-stays-on-the-machine-that-recorded-it.md) and [ADR-0543](0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md), both superseded, describe earlier placement and capture decisions. This record replaces the app's current explicit-path convention for new captures; existing links remain readable.

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

Existing explicit `audioPath` links remain readable, including files under
the former `audio/` directory. Opening does not move files or rewrite old
metadata. Native interrupted-WAV recovery checks both locations. Audio remains
an ordinary authored file; deleting a recording keeps its audio as before.

Whispering maintains these ordinary `.gitignore` rules throughout its folder:

```gitignore
*
!*/
!*.md
!.gitignore
```

Markdown and ignore files remain eligible in nested directories. Audio,
images, PDFs, configuration, and other non-Markdown files stay on disk but
are excluded when untracked. Earlier ignore text is preserved and the block
is appended when it is not the final active policy. Trailing comments and
blank lines do not trigger another append. Merged text is read again to verify
the block. Git still controls tracked files; this is an app-maintained default,
not a permanent privacy boundary.

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
