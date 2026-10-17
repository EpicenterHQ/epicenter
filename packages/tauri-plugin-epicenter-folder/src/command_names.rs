/// Every command this plugin exposes. The build script generates a permission
/// for each, and a test checks the list against the registered handlers.
pub const COMMANDS: &[&str] = &[
    "grant_directory",
    "list_folder",
    "read_folder_children",
    "read_folder_file",
    "put_folder_file",
    "make_folder_directory",
    "remove_folder_directory",
];
