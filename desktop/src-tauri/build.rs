fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_status",
            "choose_checkout",
            "checkout_request",
            "close_checkout",
            "finish_quit",
            "open_external",
            "copy_text",
        ]),
    ))
    .expect("Runlist application manifest");
}
