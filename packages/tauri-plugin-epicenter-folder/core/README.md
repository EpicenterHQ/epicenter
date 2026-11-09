# epicenter-folder-core

The folder core supplies the directory value, path rules, and storage methods
used by the Tauri folder plugin. Storage refuses every symbolic link inside a
root, including a link at the requested file path or in any parent below the root. A page
cannot create symbolic links through these methods.

A same-user program can replace a checked directory with a link between the
check and the open. In that race, one storage call could follow the replacement
outside the root. The core does not hold an operating-system directory handle
across that interval.
