/// Every command this plugin exposes. The build script generates a permission
/// for each, and a test checks the list against the registered handlers.
pub const COMMANDS: &[&str] = &[
    "inputs",
    "open_meter",
    "close_meter",
    "start",
    "stop",
    "recover",
];
