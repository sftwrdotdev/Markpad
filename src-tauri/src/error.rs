/// A lightweight error type that avoids the `Result<_, String>` boilerplate.
///
/// Internal functions use this so that `?` on `std::io::Error` and
/// `serde_json::Error` converts automatically.  Tauri commands keep their
/// `Result<T, String>` signatures — the frontend consumes those strings
/// directly, and changing them would be a breaking API change.
#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error(s)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error(e.to_string())
    }
}

impl From<Error> for String {
    fn from(e: Error) -> Self {
        e.0
    }
}
