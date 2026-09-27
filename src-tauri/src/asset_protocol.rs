//! Serves the `asset:` protocol without blocking the thread the webview calls
//! us on.
//!
//! Tauri ships its own `asset:` handler and installs it only when the app has
//! not registered one (`tauri/src/manager/webview.rs`, guarded on
//! `registered_scheme_protocols`), so registering ours replaces it and nothing
//! on the frontend has to change: `convertFileSrc`, the CSP `img-src` list,
//! the sanitizer's scheme allowlist and the export rewriter all keep working
//! against the same scheme name.
//!
//! The reason to replace it is that the built-in one does its file I/O inline.
//! wry invokes a protocol handler on the thread it records as `main_thread_id`
//! and hands it a responder precisely so the answer can come later from
//! somewhere else; tauri's asset handler ignores that and reads the file
//! before returning. A path that is slow — a share that is down, `\\wsl$\…`
//! with the distro stopped — then costs the share timeout with every window
//! frozen, and it needs no user action: one `![](pic.png)` in a document on
//! that share is enough. Upstream has this open as tauri-apps/tauri#7434
//! (2023-07-17); on the pinned 2.10.2 the block is spelled `safe_block_on`,
//! and on `dev` that call is gone but the read is still inline, so the freeze
//! survived the rewrite.
//!
//! The body below is a port of that handler (`tauri/src/protocol/asset.rs`,
//! MIT/Apache-2.0, Tauri Programme within The Commons Conservancy), kept close
//! to the original so it stays easy to diff on a tauri upgrade. Range support
//! is not optional here: `markdown.ts` renders `.mp4`/`.mp3` links as
//! `<video>`/`<audio>` pointing at this same scheme, and dropping 206 would
//! stop those from seeking.
//!
//! Three deliberate differences from upstream:
//!
//! - The multipart closing delimiter ends in `--`, as RFC 2046 requires.
//!   Upstream writes the opening separator again, so its multi-range responses
//!   are unterminated.
//! - A multipart answer carries one `Content-Type`. `Builder::header` appends
//!   rather than replaces, so upstream — which sets the file's type before it
//!   knows the request is multi-range — emits two, with the wrong one first.
//!   Both of these were found by the multipart test below.
//! - `Access-Control-Allow-Origin` echoes the request's `Origin` when it has
//!   one instead of a value computed at webview creation, which is not
//!   reachable from here. Only our own webview can issue requests on this
//!   scheme, so there is no third-party origin to echo; the fallback covers
//!   subresource loads, which send no `Origin` at all.
//!
//! Nothing here logs. The app has no logging dependency, and the status code
//! carries what went wrong: 403 traversal or scope, 404 missing, 500 read.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{LazyLock, Mutex};

use http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ORIGIN,
};
use http::{Request, Response, StatusCode};
use http_range::HttpRange;
use tauri::path::SafePathBuf;
use tauri_utils::mime_type::MimeType;

use crate::window_runtime::lock_recover;

/// The most bytes served for one range, as upstream. A player asking for the
/// rest of a large file gets the first megabyte of it and asks again.
const MAX_LEN: u64 = 1000 * 1024;

/// How many bytes are sniffed to identify the file, as upstream. A file this
/// size or smaller is kept rather than read a second time.
const MAGIC_LEN: u64 = 8192;

type Body = Cow<'static, [u8]>;

/// UNC hosts the user has opened a document from this session.
///
/// Touching a UNC path makes Windows connect to its host over SMB and offer
/// the user's NTLM credentials, and a document reaches this scheme without a
/// click: raw HTML (`<img src="http://asset.localhost/%2F%2Fhost%2Fx">`) and
/// inline CSS `url(…)` pass the sanitizer and never meet the frontend's own
/// check (`isOffHostUncPath` in markdownLinks.ts). Refusing UNC outright would
/// break the case this handler exists for — `![](pic.png)` in a document on a
/// share resolves to `//host/share/pic.png` and is served from here — and a
/// request carries no word of which document asked. So the rule is the
/// frontend's, widened to every open document: a host is reachable once the
/// user opened something from it.
static DOCUMENT_UNC_HOSTS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Records the share `document` lives on, if any. Called when a document is read.
pub(crate) fn trust_document_host(document: &str) {
    if let Some(host) = unc_host(document) {
        lock_recover(&DOCUMENT_UNC_HOSTS).insert(host);
    }
}

/// `host` in `\\host\…`, `//host/…` or any mix of the two separators. A
/// device path names its host after `UNC` (`\\?\UNC\host\…`); any other
/// device path (`\\?\C:\…`) is local.
fn unc_host(path: &str) -> Option<String> {
    let rest = path.strip_prefix(['/', '\\'])?.strip_prefix(['/', '\\'])?;
    let mut parts = rest.split(['/', '\\']);
    let mut host = parts.next()?;
    if host == "?" || host == "." {
        if !parts.next()?.eq_ignore_ascii_case("unc") {
            return None;
        }
        host = parts.next()?;
    }
    (!host.is_empty()).then(|| host.to_lowercase())
}

fn refuses_unc(path: &str, trusted: &HashSet<String>) -> bool {
    unc_host(path).is_some_and(|host| !trusted.contains(&host))
}

/// Answers one `asset:` request. Blocking: the caller is expected to be on a
/// thread that may wait on the filesystem.
///
/// `allow` is the configured asset scope, passed as a predicate so this stays
/// callable from a test without an app to build a `Scope` from.
pub fn respond(request: &Request<Vec<u8>>, allow: &dyn Fn(&str) -> bool) -> Response<Body> {
    let origin = allow_origin(request);
    match build(request, allow, &origin) {
        Ok(response) => response,
        Err(e) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(CONTENT_TYPE, "text/plain")
            .header("Access-Control-Allow-Origin", &origin)
            .body(e.to_string().into_bytes().into())
            .expect("a response with a status and two valid headers always builds"),
    }
}

fn allow_origin(request: &Request<Vec<u8>>) -> String {
    request
        .headers()
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            // The shape tauri gives a webview loaded from its own scheme. A
            // dev build served over http has a different origin, which only
            // matters for a CORS-checked request; nothing in Markpad fetches
            // this scheme, and `<img>`/`<video>` do not check.
            if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost".to_owned()
            } else {
                "tauri://localhost".to_owned()
            }
        })
}

fn build(
    request: &Request<Vec<u8>>,
    allow: &dyn Fn(&str) -> bool,
    origin: &str,
) -> Result<Response<Body>, Box<dyn std::error::Error>> {
    // `convertFileSrc` puts the whole path through `encodeURIComponent`, so
    // what arrives is a single URL segment: the leading `/` belongs to the URL
    // and every separator inside the path is percent-encoded.
    let encoded = request.uri().path().strip_prefix('/').unwrap_or_default();
    let path = percent_encoding::percent_decode(encoded.as_bytes())
        .decode_utf8_lossy()
        .to_string();

    let mut resp = Response::builder().header("Access-Control-Allow-Origin", origin);

    // Before the scope check: it canonicalizes, and that is the connection.
    if cfg!(windows) && refuses_unc(&path, &lock_recover(&DOCUMENT_UNC_HOSTS)) {
        return Ok(resp.status(StatusCode::FORBIDDEN).body(empty())?);
    }

    if SafePathBuf::new(path.clone().into()).is_err() {
        return Ok(resp.status(StatusCode::FORBIDDEN).body(empty())?);
    }

    if !allow(&path) {
        return Ok(resp.status(StatusCode::FORBIDDEN).body(empty())?);
    }

    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(e) => {
            return match e.kind() {
                std::io::ErrorKind::NotFound => {
                    Ok(resp.status(StatusCode::NOT_FOUND).body(empty())?)
                }
                std::io::ErrorKind::PermissionDenied => {
                    Ok(resp.status(StatusCode::FORBIDDEN).body(empty())?)
                }
                _ => Err(e.into()),
            };
        }
    };

    let len = file.metadata()?.len();

    let (mime_type, whole_file) = {
        let nbytes = len.min(MAGIC_LEN);
        let mut magic_buf = Vec::with_capacity(nbytes as usize);
        (&mut file).take(nbytes).read_to_end(&mut magic_buf)?;
        file.rewind()?;
        (
            MimeType::parse(&magic_buf, &path),
            // If the sniff read the file to its end, keep it: a plain request
            // for a small file is then answered without reading it twice.
            if len < MAGIC_LEN {
                Some(magic_buf)
            } else {
                None
            },
        )
    };

    // `Builder::header` appends, so `Content-Type` is set once per branch
    // below rather than here: a multipart answer carries its own type, and
    // setting the file's type first would leave two of them on the response
    // with the wrong one in front.
    let range_header = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok().map(str::to_owned));

    let response = if let Some(range_header) = range_header {
        resp = resp.header(ACCEPT_RANGES, "bytes");
        resp = resp.header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");

        let not_satisfiable = || {
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Access-Control-Allow-Origin", origin)
                .header(CONTENT_RANGE, format!("bytes */{len}"))
                .body(empty())
                .map_err(Into::into)
        };

        let Ok(parsed) = HttpRange::parse(&range_header, len) else {
            return not_satisfiable();
        };
        // to the spec's inclusive <start-end> form, e.g. 0-499
        let ranges = parsed
            .iter()
            .map(|r| (r.start, r.start + r.length - 1))
            .collect::<Vec<_>>();

        if ranges.len() == 1 {
            let (start, end) = ranges[0];
            // The range library has checked this; checked again because
            // getting it wrong here reads outside the file.
            if start >= len || end >= len || end < start {
                return not_satisfiable();
            }
            let end = start + (end - start).min(len - start).min(MAX_LEN - 1);
            let nbytes = end + 1 - start;

            let mut buf = Vec::with_capacity(nbytes as usize);
            file.seek(SeekFrom::Start(start))?;
            file.take(nbytes).read_to_end(&mut buf)?;

            resp = resp.header(CONTENT_TYPE, &mime_type);
            resp = resp.header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
            resp = resp.header(CONTENT_LENGTH, nbytes);
            resp = resp.status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf.into())
        } else {
            let ranges = ranges
                .iter()
                .filter_map(|&(start, end)| {
                    if start >= len || end >= len || end < start {
                        None
                    } else {
                        Some((
                            start,
                            start + (end - start).min(len - start).min(MAX_LEN - 1),
                        ))
                    }
                })
                .collect::<Vec<_>>();

            let boundary = boundary();
            let separator = format!("\r\n--{boundary}\r\n");
            // RFC 2046: the last delimiter is the separator plus `--`.
            let closer = format!("\r\n--{boundary}--\r\n");

            resp = resp.header(
                CONTENT_TYPE,
                format!("multipart/byteranges; boundary={boundary}"),
            );
            resp = resp.status(StatusCode::PARTIAL_CONTENT);

            let mut buf = Vec::new();
            for (start, end) in ranges {
                buf.write_all(separator.as_bytes())?;
                buf.write_all(format!("{CONTENT_TYPE}: {mime_type}\r\n").as_bytes())?;
                buf.write_all(
                    format!("{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n").as_bytes(),
                )?;
                buf.write_all(b"\r\n")?;

                let nbytes = end + 1 - start;
                let mut part = Vec::with_capacity(nbytes as usize);
                file.seek(SeekFrom::Start(start))?;
                (&mut file).take(nbytes).read_to_end(&mut part)?;
                buf.extend_from_slice(&part);
            }
            buf.write_all(closer.as_bytes())?;

            resp.body(buf.into())
        }
    } else if request.method() == http::Method::HEAD {
        resp = resp.header(CONTENT_TYPE, &mime_type);
        resp = resp.header(CONTENT_LENGTH, len);
        resp.body(empty())
    } else {
        let buf = match whole_file {
            Some(buf) => buf,
            None => {
                let mut buf = Vec::with_capacity(len as usize);
                file.read_to_end(&mut buf)?;
                buf
            }
        };
        resp = resp.header(CONTENT_TYPE, &mime_type);
        resp = resp.header(CONTENT_LENGTH, len);
        resp.body(buf.into())
    };

    response.map_err(Into::into)
}

fn empty() -> Body {
    Cow::Borrowed(&[])
}

/// A multipart boundary that will not occur in the bytes it separates.
///
/// Upstream draws this from `getrandom`. `RandomState` is seeded by the OS
/// once per process and advances per instance, which is the same guarantee at
/// the scale that matters here — two instances give 128 bits nobody chose —
/// and it costs no dependency.
fn boundary() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut out = String::with_capacity(32);
    for _ in 0..2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u8(0);
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NONCE: AtomicU32 = AtomicU32::new(0);

    fn temp_file(tag: &str, contents: &[u8]) -> PathBuf {
        let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "markpad-asset-{tag}-{}-{nonce}.png",
            std::process::id()
        ));
        std::fs::write(&path, contents).unwrap();
        path
    }

    /// The URL `convertFileSrc` would build for this path.
    fn request(path: &str) -> Request<Vec<u8>> {
        let encoded =
            percent_encoding::utf8_percent_encode(path, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        Request::builder()
            .uri(format!("asset://localhost/{encoded}"))
            .body(Vec::new())
            .unwrap()
    }

    fn ranged(path: &str, range: &str) -> Request<Vec<u8>> {
        let mut request = request(path);
        request
            .headers_mut()
            .insert("range", range.parse().unwrap());
        request
    }

    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

    fn allow_all(_: &str) -> bool {
        true
    }

    #[test]
    fn a_whole_file_comes_back_with_its_length_and_sniffed_type() {
        let mut contents = PNG_MAGIC.to_vec();
        contents.extend_from_slice(&[0u8; 64]);
        let path = temp_file("whole", &contents);

        let response = respond(&request(path.to_str().unwrap()), &allow_all);

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/png");
        assert_eq!(
            response.headers()[CONTENT_LENGTH],
            contents.len().to_string()
        );
        assert_eq!(response.body().as_ref(), contents.as_slice());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_missing_file_is_404_rather_than_an_error() {
        let path = std::env::temp_dir().join("markpad-asset-does-not-exist.png");
        let response = respond(&request(path.to_str().unwrap()), &allow_all);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_path_that_climbs_out_is_refused_before_it_is_opened() {
        let response = respond(&request("/tmp/../etc/passwd"), &allow_all);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
    }

    #[test]
    fn a_path_the_scope_rejects_is_refused() {
        let path = temp_file("scoped", PNG_MAGIC);
        let response = respond(&request(path.to_str().unwrap()), &|_| false);
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_single_range_is_answered_with_206_and_only_those_bytes() {
        let contents: Vec<u8> = (0..=255u8).collect();
        let path = temp_file("range", &contents);

        let response = respond(&ranged(path.to_str().unwrap(), "bytes=10-19"), &allow_all);

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 10-19/256");
        assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
        assert_eq!(response.body().as_ref(), &contents[10..=19]);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_range_past_the_end_is_416_and_says_how_long_the_file_is() {
        let path = temp_file("unsatisfiable", &[0u8; 16]);
        let response = respond(&ranged(path.to_str().unwrap(), "bytes=100-200"), &allow_all);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes */16");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn several_ranges_come_back_multipart_and_terminated() {
        let contents: Vec<u8> = (0..=255u8).collect();
        let path = temp_file("multipart", &contents);

        let response = respond(
            &ranged(path.to_str().unwrap(), "bytes=0-9,20-29"),
            &allow_all,
        );

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let content_type = response.headers()[CONTENT_TYPE]
            .to_str()
            .unwrap()
            .to_owned();
        let boundary = content_type
            .split("boundary=")
            .nth(1)
            .expect("multipart responses name their boundary")
            .to_owned();
        let body = String::from_utf8_lossy(response.body()).to_string();
        assert!(body.contains("bytes 0-9/256"));
        assert!(body.contains("bytes 20-29/256"));
        // RFC 2046's closing delimiter, which upstream omits
        assert!(
            body.ends_with(&format!("\r\n--{boundary}--\r\n")),
            "multipart body must end with the closing delimiter"
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn head_answers_with_the_length_and_no_body() {
        let path = temp_file("head", &[7u8; 32]);
        let mut request = request(path.to_str().unwrap());
        *request.method_mut() = http::Method::HEAD;

        let response = respond(&request, &allow_all);

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_LENGTH], "32");
        assert!(response.body().is_empty());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn the_requesting_origin_is_the_one_allowed_back() {
        let path = temp_file("origin", PNG_MAGIC);
        let mut request = request(path.to_str().unwrap());
        request
            .headers_mut()
            .insert(ORIGIN, "tauri://localhost".parse().unwrap());

        let response = respond(&request, &allow_all);

        assert_eq!(
            response.headers()["Access-Control-Allow-Origin"],
            "tauri://localhost"
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn a_unc_path_is_refused_unless_a_document_came_from_its_host() {
        let trusted = HashSet::from(["server".to_owned()]);
        for path in [
            r"\\evil.example\share\a.png",
            "//evil.example/share/a.png",
            r"/\evil.example\share\a.png",
        ] {
            assert!(refuses_unc(path, &trusted), "{path}");
        }
        assert!(!refuses_unc(r"\\SERVER\share\img\a.png", &trusted));
        assert!(!refuses_unc("//server/share/a.png", &trusted));
        assert!(!refuses_unc(r"C:\notes\a.png", &trusted));
        // A device path names its host after `UNC`; any other one is local.
        assert!(refuses_unc(r"\\?\UNC\evil.example\share\a.png", &trusted));
        assert!(refuses_unc("//./UNC/evil.example/share/a.png", &trusted));
        assert!(!refuses_unc(r"\\?\UNC\server\share\a.png", &trusted));
        assert!(!refuses_unc(r"\\?\C:\notes\a.png", &trusted));
        assert!(!refuses_unc("/notes/a.png", &trusted));
    }

    #[cfg(windows)]
    #[test]
    fn a_unc_path_is_refused_before_the_scope_or_the_filesystem_sees_it() {
        // The scope check canonicalizes, which is itself the SMB connection.
        let response = respond(
            &request(r"\\markpad-untrusted.invalid\share\a.png"),
            &|_| panic!("the scope was consulted"),
        );
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        trust_document_host(r"\\markpad-trusted.invalid\share\doc.md");
        let asked = std::cell::Cell::new(false);
        respond(&request("//markpad-trusted.invalid/share/a.png"), &|_| {
            asked.set(true);
            false
        });
        assert!(asked.get(), "a document's own share is still served");
    }
}
