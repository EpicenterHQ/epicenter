/// Every command this plugin exposes. The build script generates a permission
/// for each, and a test checks the list against the registered handlers.
pub const COMMANDS: &[&str] = &[
    "grant_directory",
    "run_git",
    "cancel_git",
    "read_folder_directory",
    "stat_folder_path",
    "read_folder_file",
    "write_folder_file",
    "rename_folder_path",
    "remove_folder_path",
    "make_folder_directory",
];
