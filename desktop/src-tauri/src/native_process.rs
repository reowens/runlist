use std::{path::Path, process::Command};
#[cfg(windows)]
use std::path::PathBuf;

pub fn runtime_name() -> &'static str {
    if cfg!(windows) { "RunlistHelper.exe" } else { "RunlistHelper" }
}

pub fn helper_command(engine: &Path) -> Command {
    let mut cmd = Command::new(engine.join("runtime").join(runtime_name()));
    cmd.env_clear();
    // An allowlist, rather than removal of known agent variables, also excludes
    // Node loaders, Git overrides, shell startup files and inherited credentials.
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL",
        "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH", "APPDATA",
        "LOCALAPPDATA", "ProgramData", "SystemRoot", "WINDIR", "TEMP", "TMP",
        "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "GNUPGHOME"] {
        if let Some(value) = std::env::var_os(key) { cmd.env(key, value); }
    }
    #[cfg(target_os = "macos")]
    cmd.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
    #[cfg(target_os = "linux")]
    cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let mut paths: Vec<PathBuf> = Vec::new();
        if let Some(root) = std::env::var_os("SystemRoot") {
            paths.push(PathBuf::from(&root).join("System32"));
            paths.push(PathBuf::from(root));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(key) {
                paths.push(PathBuf::from(root).join("Git/cmd"));
            }
        }
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(root).join("Programs/Git/cmd"));
        }
        // Support user-installed Git while discarding empty/relative PATH entries.
        // These user-configured tool directories are part of checkout execution trust.
        if let Some(value) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&value).filter(|p|p.is_absolute()));
        }
        paths.retain(|p|p.is_absolute());
        if let Ok(value) = std::env::join_paths(paths) { cmd.env("PATH", value); }
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW for the Node helper.
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_uses_bundled_executable_and_allowlisted_environment() {
        let engine = std::env::temp_dir().join("runlist-engine");
        let cmd = helper_command(&engine);
        assert_eq!(Path::new(cmd.get_program()), engine.join("runtime").join(runtime_name()));
        let env: Vec<_> = cmd.get_envs().collect();
        assert!(env.iter().any(|(k,v)| *k == "PATH" && v.is_some()));
        for key in ["CODEX_THREAD_ID", "OPENCODE_SESSION_ID", "NODE_OPTIONS", "NODE_PATH", "GIT_DIR", "BASH_ENV", "AWS_SECRET_ACCESS_KEY"] {
            assert!(!env.iter().any(|(k,_)| *k == key));
        }
    }
}
