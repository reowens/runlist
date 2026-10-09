use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
mod native_files;
mod native_process;
mod native_navigation;
use native_files::{instance_lock, open_state_file};
#[cfg(test)]
mod headless_tests;
const MAX: usize = 32 * 1024 * 1024;
const VERSION: &str = env!("CARGO_PKG_VERSION");
#[derive(Clone, Serialize, Deserialize)]
struct Trust {
    root: PathBuf,
    config: Option<PathBuf>,
    fingerprint: String,
    files: Vec<String>,
    volatile: bool,
    executable: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Recent {
    root: PathBuf,
    fingerprint: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Preferences {
    recent: Vec<Recent>,
}
struct Helper {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Result<String, String>>,
    handle: String,
    root: PathBuf,
    actor: Value,
}
impl Helper {
    fn call(&mut self, op: &str, route: Option<&str>, body: Option<Value>) -> Result<Value, Value> {
        let id = Uuid::new_v4().to_string();
        let mut frame =
            json!({"protocol":1,"version":VERSION,"id":id,"op":op,"handle":self.handle});
        if let Some(route) = route {
            frame["route"] = json!(route);
        }
        if let Some(body) = body {
            frame["body"] = body;
        }
        let wire = serde_json::to_vec(&frame)
            .map_err(|_| problem("invalid-request", "Invalid request."))?;
        if wire.len() > MAX {
            return Err(problem(
                "invalid-request",
                "The request exceeds the protocol limit.",
            ));
        }
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| problem("checkout-closed", "Open a checkout folder."))?;
        input.write_all(&wire).and_then(|_|input.write_all(b"\n")).and_then(|_|input.flush()).map_err(|_|problem("helper-uncertain","The helper stopped. Reopen the folder and inspect retained operations before retrying."))?;
        let line=self.output.recv_timeout(Duration::from_secs(75)).map_err(|_|problem("helper-uncertain","The helper did not report an outcome. Your recovery state is retained; inspect the operation before retrying."))?.map_err(|_|problem("helper-uncertain","The helper pipe closed. Reopen the folder and inspect retained operations."))?;
        let reply: Value = serde_json::from_str(&line)
            .map_err(|_| problem("protocol-mismatch", "The helper returned an invalid frame."))?;
        if reply["protocol"] != 1 || reply["id"] != id {
            return Err(problem(
                "protocol-mismatch",
                "The helper response does not match this request.",
            ));
        }
        if reply["ok"] == true {
            Ok(reply["value"].clone())
        } else {
            Err(reply["error"].clone())
        }
    }
    fn stop(&mut self) {
        // EOF waits for queued work. No SIGTERM during a potentially committing write.
        self.input.take();
        for _ in 0..800 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => return,
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        // The existing lifecycle engine has a 60s worker deadline and durable receipts.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Host {
    helper: Mutex<Option<Helper>>,
    closing: AtomicBool,
    preferences: Mutex<Preferences>,
    data: PathBuf,
    engine: PathBuf,
    _lock: File,
}
fn problem(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message,"details":{}})
}
fn ensure_open(host: &Host) -> Result<(), Value> {
    if host.closing.load(Ordering::Acquire) {
        return Err(problem(
            "app-closing",
            "Runlist is finishing its local operations.",
        ));
    }
    Ok(())
}
fn command(engine: &Path) -> Command {
    let mut cmd = native_process::helper_command(engine);
    cmd.arg("--max-old-space-size=256")
        .arg("--max-semi-space-size=4")
        .arg(engine.join("desktop/helper.mjs"));
    cmd
}
fn probe(engine: &Path, root: &Path) -> Result<Trust, Value> {
    let output = command(engine)
        .args(["--probe"])
        .arg(root)
        .output()
        .map_err(|_| {
            problem(
                "runtime-missing",
                "The bundled Runlist Helper could not start.",
            )
        })?;
    if !output.status.success() {
        return Err(problem(
            "checkout-unavailable",
            std::str::from_utf8(&output.stderr)
                .unwrap_or("Cannot inspect this checkout.")
                .trim(),
        ));
    }
    if output.stdout.len() > MAX {
        return Err(problem(
            "invalid-checkout",
            "The configuration manifest is too large.",
        ));
    }
    let trust: Trust = serde_json::from_slice(&output.stdout).map_err(|_| {
        problem(
            "protocol-mismatch",
            "Cannot read the bundled trust manifest.",
        )
    })?;
    if dunce::canonicalize(&trust.root).ok().as_ref() != Some(&trust.root) {
        return Err(problem(
            "invalid-checkout",
            "Choose a canonical checkout folder.",
        ));
    }
    Ok(trust)
}
fn start(engine: &Path, trust: &Trust) -> Result<Helper, Value> {
    let mut child = command(engine)
        .arg("--serve")
        .arg(&trust.root)
        .arg(&trust.fingerprint)
        .current_dir(&trust.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            problem(
                "runtime-missing",
                "The bundled Runlist Helper could not start.",
            )
        })?;
    let input = child.stdin.take();
    let output = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    // Discard diagnostics; checkout hooks may print private paths or document text.
    std::thread::spawn(move || {
        let mut buffer = [0; 8192];
        while let Ok(n) = stderr.read(&mut buffer) {
            if n == 0 {
                break;
            }
        }
    });
    let (tx, rx) = mpsc::sync_channel(2);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = String::new();
            match (&mut reader).take((MAX + 2) as u64).read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line.len() <= MAX + 1 && line.ends_with('\n') => {
                    if tx.send(Ok(line)).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = tx.send(Err("Invalid protocol frame".into()));
                    break;
                }
            }
        }
    });
    let mut helper = Helper {
        child,
        input,
        output: rx,
        handle: Uuid::new_v4().to_string(),
        root: trust.root.clone(),
        actor: Value::Null,
    };
    let reply = helper.call("hello", None, None)?;
    if reply["version"] != VERSION || reply["protocol"] != 1 {
        return Err(problem(
            "protocol-mismatch",
            "The app and bundled engine versions differ.",
        ));
    }
    helper.actor = reply["actor"].clone();
    Ok(helper)
}
fn save_preferences(host: &Host, prefs: &Preferences) -> Result<(), Value> {
    let temp = host.data.join("recent.tmp");
    let mut file = open_state_file(&temp)
        .map_err(|_| problem("preferences-unavailable", "Cannot save recent checkouts."))?;
    file.set_len(0)
        .map_err(|_| problem("preferences-unavailable", "Cannot save recent checkouts."))?;
    file.write_all(&serde_json::to_vec(prefs).unwrap())
        .and_then(|_| file.sync_all())
        .map_err(|_| problem("preferences-unavailable", "Cannot save recent checkouts."))?;
    drop(file); // Windows replacement requires the temporary handle to close.
    fs::rename(temp, host.data.join("recent.json"))
        .map_err(|_| problem("preferences-unavailable", "Cannot save recent checkouts."))?;
    Ok(())
}
fn status(host: &Host) -> Result<Value, Value> {
    let helper = host
        .helper
        .lock()
        .map_err(|_| problem("host-unavailable", "Restart Runlist."))?;
    let recents = host
        .preferences
        .lock()
        .unwrap()
        .recent
        .iter()
        .enumerate()
        .map(|(id, r)| json!({"id":id,"path":r.root}))
        .collect::<Vec<_>>();
    Ok(match helper.as_ref() {
        Some(h) => {
            json!({"version":VERSION,"handle":h.handle,"checkoutPath":h.root,"actor":h.actor,"recent":recents})
        }
        None => json!({"version":VERSION,"handle":null,"recent":recents}),
    })
}
#[tauri::command]
async fn desktop_status(app: tauri::AppHandle) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || status(&app.state::<Host>()))
        .await
        .map_err(|_| problem("host-unavailable", "Restart Runlist."))?
}
#[tauri::command]
async fn choose_checkout(app: tauri::AppHandle, recent: Option<usize>) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move||{
  let host=app.state::<Host>();let mut active=host.helper.lock().unwrap();ensure_open(&host)?;
  // The renderer preserves drafts and blocks pending reviews before invoking this.
  let root=if let Some(id)=recent {host.preferences.lock().unwrap().recent.get(id).map(|r|r.root.clone()).ok_or_else(||problem("invalid-checkout","Choose a known recent checkout."))?}
  else {let window=app.get_webview_window("main").unwrap();match app.dialog().file().set_parent(&window).set_title("Open a Runlist checkout").blocking_pick_folder(){Some(file)=>file.into_path().map_err(|_|problem("invalid-checkout","Choose a local folder."))?,None=>return Ok(json!({"cancelled":true}))}};
  #[cfg(debug_assertions)] eprintln!("Runlist: folder selected");
  let trust=probe(&host.engine,&root)?;
  #[cfg(debug_assertions)] eprintln!("Runlist: configuration inspected");
  let known=!trust.volatile&&host.preferences.lock().unwrap().recent.iter().any(|r|r.root==trust.root&&r.fingerprint==trust.fingerprint);
  if trust.executable&&!known {
   let message=format!("{}\n\nThis checkout contains executable Runlist configuration and hooks ({} inspected files). Trust only code you know: it runs with your user permissions and may access files or the network.\n\nRunlist's document operations use local files and private pipes.{}",trust.root.display(),trust.files.len(),if trust.volatile{"\nDynamic loading requires confirmation every time this folder opens."}else{"\nThis trust is remembered until inspected configuration dependencies change."});
   if !app.dialog().message(message).parent(&app.get_webview_window("main").unwrap()).title("Trust this checkout’s configuration?").buttons(MessageDialogButtons::OkCancelCustom("Trust and open".into(),"Cancel".into())).blocking_show(){return Ok(json!({"cancelled":true}));}
  }
  #[cfg(debug_assertions)] eprintln!("Runlist: trust decision complete");
  // Probe again after the user's decision; never import changed code silently.
  if probe(&host.engine,&trust.root)?.fingerprint!=trust.fingerprint{return Err(problem("trust-changed","Configuration changed while the trust dialog was open. Choose the folder again."));}
  ensure_open(&host)?;
  // Keep the current checkout available if the candidate cannot initialize.
  let helper=start(&host.engine,&trust)?;
  if let Some(mut old)=active.take(){old.stop();}
  let result=json!({"version":VERSION,"handle":helper.handle,"actor":helper.actor,"checkoutPath":helper.root});*active=Some(helper);
  let mut prefs=host.preferences.lock().unwrap();prefs.recent.retain(|r|r.root!=trust.root);prefs.recent.insert(0,Recent{root:trust.root,fingerprint:trust.fingerprint});prefs.recent.truncate(12);save_preferences(&host,&prefs)?;Ok(result)
 }).await.map_err(|_|problem("host-unavailable","The folder operation stopped."))?
}
#[tauri::command]
async fn checkout_request(
    app: tauri::AppHandle,
    handle: String,
    route: String,
    body: Option<Value>,
) -> Result<Value, Value> {
    let endpoint = route.split('?').next().unwrap_or("");
    const READ: &[&str] = &[
        "templates",
        "library",
        "plans",
        "document",
        "link",
        "settings",
        "lifecycle",
        "yardstick",
        "filing",
        "records",
        "create",
        "search",
        "semantic/settings",
        "semantic/result",
        "recovery",
        "git/status",
        "git/diff",
        "git/operation",
    ];
    const WRITE: &[&str] = &[
        "semantic/settings",
        "semantic/start",
        "semantic/cancel",
        "git/commit/preview",
        "git/commit/start",
        "git/operation/inspect",
        "git/operation/recover",
        "git/operation/cancel",
        "git/operation/settle",
        "create/preview",
        "create/commit",
        "create/inspect",
        "create/discard",
        "yardstick/preview",
        "yardstick/commit",
        "yardstick/inspect",
        "yardstick/settle",
        "lifecycle/preview",
        "lifecycle/commit",
        "lifecycle/inspect",
        "lifecycle/settle",
        "native/preview",
        "native/action",
        "flags/triage",
        "decisions/preview",
        "templates/save",
        "save",
        "undo",
        "draft/read",
        "draft/write",
        "draft/discard",
        "operation/inspect",
        "operation/settle",
    ];
    if route.len() > 8192
        || !(if body.is_some() { WRITE } else { READ }).contains(&endpoint)
        || route.contains('#')
    {
        return Err(problem(
            "invalid-request",
            "Choose a supported checkout operation.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<Host>();
        let mut slot = host.helper.lock().unwrap();
        ensure_open(&host)?;
        let helper = slot
            .as_mut()
            .ok_or_else(|| problem("checkout-closed", "Open a checkout folder."))?;
        if helper.handle != handle {
            return Err(problem("forbidden", "This checkout handle is inactive."));
        }
        let result = helper.call("request", Some(&format!("/api/{route}")), body);
        if result.as_ref().err().is_some_and(|error| {
            matches!(
                error["code"].as_str(),
                Some("helper-uncertain" | "protocol-mismatch")
            )
        }) {
            // A lost response cannot safely be paired with the next request.
            // EOF drains accepted work; reopening uses durable receipt inspection.
            if let Some(mut failed) = slot.take() {
                failed.stop();
            }
        }
        result
    })
    .await
    .map_err(|_| {
        problem(
            "helper-uncertain",
            "The operation stopped. Inspect its retained outcome.",
        )
    })?
}
#[tauri::command]
async fn close_checkout(app: tauri::AppHandle, handle: String) -> Result<Value, Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<Host>();
        let mut slot = host.helper.lock().unwrap();
        if slot.as_ref().map(|h| h.handle.as_str()) != Some(&handle) {
            return Err(problem("forbidden", "This checkout handle is inactive."));
        }
        if let Some(mut helper) = slot.take() {
            helper.stop();
        }
        Ok(json!({"disconnected":true}))
    })
    .await
    .map_err(|_| problem("host-unavailable", "Close failed."))?
}
#[tauri::command]
async fn finish_quit(app: tauri::AppHandle) -> Result<(), Value> {
    app.state::<Host>().closing.store(true, Ordering::Release);
    let quit = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mut helper) = quit.state::<Host>().helper.lock().unwrap().take() {
            helper.stop();
        }
    })
    .await
    .map_err(|_| {
        problem(
            "helper-uncertain",
            "Wait for the active operation before quitting.",
        )
    })?;
    app.exit(0);
    Ok(())
}
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), Value> {
    if url.len() > 4096 || url.contains(['\r', '\n']) {
        return Err(problem("invalid-link", "Unsupported link."));
    }
    let parsed =
        tauri::Url::parse(&url).map_err(|_| problem("invalid-link", "Unsupported link."))?;
    if !native_navigation::is_external_url(&parsed) {
        return Err(problem(
            "invalid-link",
            "Only web and email links can open externally.",
        ));
    }
    app.opener().open_url(url, None::<&str>)
        .map_err(|_| problem("open-failed", "Could not open the link."))?;
    Ok(())
}
#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<(), Value> {
    if text.len() > MAX {
        return Err(problem("invalid-request", "Clipboard text is too large."));
    }
    app.clipboard().write_text(text)
        .map_err(|_| problem("clipboard-unavailable", "Could not copy source."))?;
    Ok(())
}
fn native_event(app: &tauri::AppHandle, event: &str) {
    let _ = app.emit(event, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub fn run() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .enable_all()
        .build()
        .expect("Runlist async runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    let builder=tauri::Builder::default().plugin(tauri_plugin_dialog::init())
 .plugin(tauri_plugin_clipboard_manager::init())
 .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
 .invoke_handler(tauri::generate_handler![desktop_status,choose_checkout,checkout_request,close_checkout,finish_quit,open_external,copy_text])
 .setup(|app|{
  let data=app.path().app_data_dir()?;fs::create_dir_all(&data)?;
  let Some(lock)=instance_lock(&data.join("instance.lock"))? else {std::process::exit(0);};
  let engine=app.path().resource_dir()?.join("engine");
  let preferences=fs::read(data.join("recent.json")).ok().filter(|s|s.len()<1024*1024).and_then(|s|serde_json::from_slice(&s).ok()).unwrap_or_default();
  tauri::WebviewWindowBuilder::from_config(app,&app.config().app.windows[0])?.on_navigation(native_navigation::is_asset_url).build()?;
  app.manage(Host{helper:Mutex::new(None),closing:AtomicBool::new(false),preferences:Mutex::new(preferences),data,engine,_lock:lock});
  use tauri::menu::{Menu,MenuItem,PredefinedMenuItem,Submenu};
  let about=PredefinedMenuItem::about(app,Some("About Runlist"),Some(tauri::menu::AboutMetadata{name:Some("Runlist".into()),version:Some(VERSION.into()),comments:Some("Local files · This computer only\nMarkdown plans, hubs, documents, decisions and flags.".into()),..Default::default()}))?;
  let quit=MenuItem::with_id(app,"quit","Quit Runlist",true,Some("CmdOrCtrl+Q"))?;
  #[cfg(target_os="macos")]
  let application=Submenu::with_items(app,"Runlist",true,&[&about,&PredefinedMenuItem::separator(app)?,&PredefinedMenuItem::hide(app,None)?,&PredefinedMenuItem::hide_others(app,None)?,&PredefinedMenuItem::show_all(app,None)?,&PredefinedMenuItem::separator(app)?,&quit])?;
  #[cfg(not(target_os="macos"))]
  let application=Submenu::with_items(app,"Runlist",true,&[&about,&PredefinedMenuItem::separator(app)?,&quit])?;
  let open=MenuItem::with_id(app,"open","Open Folder…",true,Some("CmdOrCtrl+O"))?;
  let close=MenuItem::with_id(app,"close","Close Window",true,Some("CmdOrCtrl+W"))?;
  let file=Submenu::with_items(app,"File",true,&[&open,&close])?;
  #[cfg(target_os="macos")]
  let undo=PredefinedMenuItem::undo(app,None)?;
  #[cfg(target_os="macos")]
  let redo=PredefinedMenuItem::redo(app,None)?;
  #[cfg(not(target_os="macos"))]
  let undo=MenuItem::with_id(app,"edit-undo","Undo",true,Some("CmdOrCtrl+Z"))?;
  #[cfg(not(target_os="macos"))]
  let redo=MenuItem::with_id(app,"edit-redo","Redo",true,Some("CmdOrCtrl+Shift+Z"))?;
  let edit=Submenu::with_items(app,"Edit",true,&[&undo,&redo,&PredefinedMenuItem::separator(app)?,&PredefinedMenuItem::cut(app,None)?,&PredefinedMenuItem::copy(app,None)?,&PredefinedMenuItem::paste(app,None)?,&PredefinedMenuItem::select_all(app,None)?])?;
  app.set_menu(Menu::with_items(app,&[&application,&file,&edit])?)?;Ok(())
 })
 .on_menu_event(|app,event|match event.id().as_ref(){"open"=>native_event(app,"runlist:open"),"quit"|"close"=>native_event(app,"runlist:quit"),"edit-undo"=>{let _=app.emit("runlist:edit","undo");},"edit-redo"=>{let _=app.emit("runlist:edit","redo");},_=>{}})
 .on_window_event(|window,event|if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();native_event(window.app_handle(),"runlist:quit");});
    let app = builder
        .build(tauri::generate_context!())
        .expect("Runlist desktop startup");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } => {
            api.prevent_exit();
            native_event(app, "runlist:quit");
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
