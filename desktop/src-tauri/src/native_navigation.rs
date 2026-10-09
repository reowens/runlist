pub fn is_asset_url(url: &tauri::Url) -> bool {
    // Use only the framework's production asset origin for this platform.
    // The Windows custom-protocol URL does not represent a network listener.
    let (scheme, host) = if cfg!(windows) { ("http", "tauri.localhost") } else { ("tauri", "localhost") };
    url.scheme() == scheme && url.host_str() == Some(host)
        && url.port().is_none() && url.username().is_empty() && url.password().is_none()
}

pub fn is_external_url(url: &tauri::Url) -> bool {
    if !["http", "https", "mailto"].contains(&url.scheme()) { return false; }
    // Never hand framework asset or IPC addresses to a system browser.
    !matches!(url.host_str(), Some("tauri.localhost" | "ipc.localhost"))
        && url.username().is_empty() && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn asset_navigation_rejects_remote_and_lookalike_origins() {
        let origin = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
        for tail in ["/", "/index.html#heading", "/?q=test"] {
            assert!(is_asset_url(&tauri::Url::parse(&format!("{origin}{tail}")).unwrap()));
        }
        for input in ["https://example.com", "http://localhost", "http://tauri.localhost.evil", "tauri://remote", "http://tauri.localhost:1234", "tauri://user@localhost", "https://tauri.localhost"] {
            assert!(!is_asset_url(&tauri::Url::parse(input).unwrap()));
        }
    }
    #[test]
    fn external_links_accept_web_and_email_only() {
        for input in ["https://example.com", "http://example.com", "mailto:person@example.com"] {
            assert!(is_external_url(&tauri::Url::parse(input).unwrap()));
        }
        for input in ["file:///tmp/private", "javascript:alert(1)", "tauri://localhost/", "http://tauri.localhost/", "https://ipc.localhost/", "https://user:secret@example.com"] {
            assert!(!is_external_url(&tauri::Url::parse(input).unwrap()));
        }
    }
}
