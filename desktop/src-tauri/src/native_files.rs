// File ownership only: no Tauri app/window, daemon, listener or PID-file lease.
use std::{
    fs::{File, OpenOptions, TryLockError},
    io,
    path::Path,
};

pub(crate) fn open_state_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        // Open the link itself, then reject all reparse points by handle. Do not
        // share deletion: a live lock must not be renamed out from under us.
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Runlist state must be a regular file.",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Runlist state may not be a reparse point.",
            ));
        }
        // Files inherit the per-user application directory's Windows ACL.
        // Unix mode bits are not a Windows ACL or a host qualification result.
    }
    Ok(file)
}

pub(crate) fn instance_lock(path: &Path) -> io::Result<Option<File>> {
    let file = open_state_file(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "runlist-native-files-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn path(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lock_probe_child() {
        let Some(path) = std::env::var_os("RUNLIST_LOCK_TEST_PATH") else {
            return;
        };
        let expected = std::env::var("RUNLIST_LOCK_TEST_EXPECT").unwrap();
        let mut available = instance_lock(Path::new(&path)).unwrap().is_some();
        if expected == "available" {
            // Parallel tests also spawn children. A descriptor inherited during
            // a concurrent spawn can retain the lock until that child's exec
            // closes it. Check eventual release, with a strict two-second bound;
            // the held-lock probe must still refuse on its very first attempt.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while !available && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(10));
                available = instance_lock(Path::new(&path)).unwrap().is_some();
            }
        }
        assert_eq!(
            available,
            expected == "available"
        );
    }

    #[test]
    fn lock_excludes_another_process_and_releases_on_close() {
        let fixture = Fixture::new();
        let path = fixture.path("instance.lock");
        let held = instance_lock(&path).unwrap().unwrap();
        assert!(instance_lock(&path).unwrap().is_none());
        let probe = |expected: &str| {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "native_files::tests::lock_probe_child",
                    "--nocapture",
                ])
                .env("RUNLIST_LOCK_TEST_PATH", &path)
                .env("RUNLIST_LOCK_TEST_EXPECT", expected)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        probe("held");
        drop(held);
        probe("available");
        assert!(path.exists()); // Never unlink a live or retired lock file.
    }

    #[test]
    fn opening_state_does_not_truncate_and_errors_are_not_another_instance() {
        let fixture = Fixture::new();
        let path = fixture.path("recent.tmp");
        fs::write(&path, "retained state").unwrap();
        let file = open_state_file(&path).unwrap();
        assert_eq!(file.metadata().unwrap().len(), 14);
        drop(file);
        assert_eq!(fs::read_to_string(&path).unwrap(), "retained state");
        assert!(instance_lock(&fixture.path("missing/instance.lock")).is_err());
        assert!(open_state_file(&fixture.0).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let private = open_state_file(&fixture.path("new-private")).unwrap();
            assert_eq!(
                private.metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn state_and_lock_refuse_symlinks_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture.path("outside");
        let link = fixture.path("recent.tmp");
        fs::write(&target, "preserve target").unwrap();
        symlink(&target, &link).unwrap();
        assert!(open_state_file(&link).is_err());
        assert!(instance_lock(&link).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "preserve target");
    }
}
