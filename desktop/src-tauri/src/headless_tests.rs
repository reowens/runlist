// Exercise native process ownership/shutdown without constructing a Tauri
// application or window. The same Helper implementation drives the real bundle.
use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("runlist-native-headless-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("docs/plans")).unwrap();
        fs::write(root.join("runlist.config.mjs"), "export const root='docs';\n").unwrap();
        fs::write(root.join("docs/plans/check.md"), "---\ntype: plan\nstatus: active\ncustom: retained\n---\n# Native shutdown\n\nOriginal.\n").unwrap();
        Self(dunce::canonicalize(root).unwrap())
    }
    fn engine(&self) -> PathBuf {
        std::env::var_os("RUNLIST_TEST_ENGINE").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    }
    fn helper(&self) -> Helper {
        let engine = self.engine();
        start(&engine, &probe(&engine, &self.0).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[test]
fn native_shutdown_drains_an_accepted_write_and_reaps_the_bundled_helper() {
    let fixture = Fixture::new();
    let mut helper = fixture.helper();
    let doc = helper.call("request", Some("/api/document?path=docs/plans/check.md"), None).unwrap();
    let operation = Uuid::new_v4().to_string();
    let expected = doc["source"].as_str().unwrap().replace("Original.", "Accepted before EOF.");
    let frame = json!({"protocol":1,"version":VERSION,"id":Uuid::new_v4().to_string(),
        "op":"request","handle":helper.handle,"route":"/api/save",
        "body":{"path":"docs/plans/check.md","operationId":operation,
            "expectedRevision":doc["revision"],"source":expected}});
    let input = helper.input.as_mut().unwrap();
    writeln!(input, "{}", frame).unwrap();
    input.flush().unwrap();
    // This is the same EOF-based retirement used by finish_quit and Drop.
    helper.stop();
    assert!(helper.child.try_wait().unwrap().unwrap().success());
    assert!(helper.input.is_none());
    assert_eq!(fs::read_to_string(fixture.0.join("docs/plans/check.md")).unwrap(), expected);
    assert_eq!(helper.call("request", Some("/api/library"), None).unwrap_err()["code"], "checkout-closed");
    let mut reopened = fixture.helper();
    let receipt = reopened.call("request", Some("/api/operation/inspect"), Some(json!({"operationId":operation}))).unwrap();
    assert_eq!(receipt["state"], "committed");
    assert_eq!(receipt["after"], expected);
    reopened.stop();
}

#[test]
fn native_closing_fence_refuses_new_work_before_helper_retirement() {
    let fixture = Fixture::new();
    let host = Host { helper:Mutex::new(None), closing:AtomicBool::new(false),
        preferences:Mutex::new(Preferences::default()), data:fixture.0.clone(),
        engine:fixture.engine(), _lock:File::create(fixture.0.join("test.lock")).unwrap() };
    assert!(ensure_open(&host).is_ok());
    host.closing.store(true, Ordering::Release);
    assert_eq!(ensure_open(&host).unwrap_err()["code"], "app-closing");
}

#[test]
fn native_preferences_replace_closed_temp_handles_and_refuse_linked_state() {
    let fixture = Fixture::new();
    let host = Host { helper:Mutex::new(None), closing:AtomicBool::new(false),
        preferences:Mutex::new(Preferences::default()), data:fixture.0.clone(),
        engine:fixture.engine(), _lock:instance_lock(&fixture.0.join("instance.lock")).unwrap().unwrap() };
    for fingerprint in ["first", "updated"] {
        let prefs = Preferences { recent:vec![Recent { root:fixture.0.clone(), fingerprint:fingerprint.into() }] };
        save_preferences(&host, &prefs).unwrap();
        let saved: Preferences = serde_json::from_slice(&fs::read(fixture.0.join("recent.json")).unwrap()).unwrap();
        assert_eq!(saved.recent[0].fingerprint, fingerprint);
        assert!(!fixture.0.join("recent.tmp").exists());
    }
    #[cfg(unix)] {
        let target = fixture.0.join("untouched"); fs::write(&target, "preserve").unwrap();
        std::os::unix::fs::symlink(&target, fixture.0.join("recent.tmp")).unwrap();
        assert_eq!(save_preferences(&host, &Preferences::default()).unwrap_err()["code"], "preferences-unavailable");
        assert_eq!(fs::read_to_string(target).unwrap(), "preserve");
    }
}

#[test]
fn native_workspace_creation_search_and_disk_recovery_use_private_pipes() {
    let fixture = Fixture::new();
    let mut helper = fixture.helper();
    let operation = Uuid::new_v4().to_string();
    let request = json!({"template":"doc","title":"Native workspace fixture",
        "folder":"docs","filename":"native-workspace.md","status":"active",
        "body":"## Native workspace section\n\nunique_native_workspace_needle\n", "operationId":operation});
    let review = helper.call("request", Some("/api/create/preview"), Some(request)).unwrap();
    assert_eq!(review["state"], "reviewed");
    assert!(!fixture.0.join("docs/native-workspace.md").exists());
    let pending = helper.call("request", Some("/api/recovery"), None).unwrap();
    assert!(pending["items"].as_array().unwrap().iter().any(|item| item["operationId"] == operation));
    let commit = helper.call("request", Some("/api/create/commit"), Some(json!({"operationId":operation}))).unwrap();
    assert_eq!(commit["state"], "committed");
    let expected = review["source"].as_str().unwrap();
    assert_eq!(fs::read_to_string(fixture.0.join("docs/native-workspace.md")).unwrap(), expected);
    let results = helper.call("request", Some("/api/search?q=unique_native_workspace_needle"), None).unwrap();
    assert_eq!(results["documents"][0]["path"], "docs/native-workspace.md");
    let doc = helper.call("request", Some("/api/document?path=docs/native-workspace.md"), None).unwrap();
    let draft = Uuid::new_v4().to_string();
    let pending_save = Uuid::new_v4().to_string();
    helper.call("request", Some("/api/draft/write"), Some(json!({"path":"docs/native-workspace.md",
        "draftId":draft,"expectedDraftRevision":null,"baseSource":doc["source"],
        "baseRevision":doc["revision"],"source":format!("{}\nNative draft only.\n",expected),
        "pendingOperation":{"operationId":pending_save,"kind":"save","expectedRevision":doc["revision"]}}))).unwrap();
    helper.stop();
    let mut reopened = fixture.helper();
    let recovery = reopened.call("request", Some("/api/recovery"), None).unwrap();
    let row = recovery["items"].as_array().unwrap().iter().find(|item| item["draftId"] == draft).unwrap();
    assert_eq!(row["pendingOperation"]["operationId"], pending_save);
    assert!(row.get("source").is_none());
    assert_eq!(fs::read_to_string(fixture.0.join("docs/native-workspace.md")).unwrap(), expected);
    let retried = reopened.call("request", Some("/api/create/commit"), Some(json!({"operationId":operation}))).unwrap();
    assert_eq!(retried["replayed"], true);
    reopened.stop();
}
