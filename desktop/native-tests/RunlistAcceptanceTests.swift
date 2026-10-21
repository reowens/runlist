import AppKit
import Darwin
import XCTest

final class RunlistAcceptanceTests: XCTestCase {
    private let bundleIdentifier = "dev.reowens.runlist"
    private var app: XCUIApplication!
    private var fixture: URL!
    private var document: URL!
    private var appPID: pid_t?
    private var ownedPIDs = Set<pid_t>()
    private let prefix = "---\ntype: plan\nstatus: active\ncustom: preserved 先 🧭\n---\n"
    private let originalBody = "# Air acceptance\n\nOriginal paragraph.\n\n## Version History\n\n- Existing history.\n"
    private let savedBody = "# Air acceptance\n\nSaved exact text 123.\n\n## Version History\n\n- Existing history.\n"

    override func setUpWithError() throws {
        continueAfterFailure = false
        let jobs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("hetchy-worker.noindex/native-projects/runlist/jobs", isDirectory: true)
        let bundle = Bundle(for: RunlistAcceptanceTests.self).bundleURL.standardizedFileURL
        guard bundle.path.hasPrefix(jobs.path + "/") else {
            throw NSError(domain: "RunlistAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: "Test bundle is outside the Air jobs directory."])
        }
        let components = String(bundle.path.dropFirst(jobs.path.count + 1)).split(separator: "/")
        guard components.count > 2, components[1] == "DerivedData",
              String(components[0]).range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$", options: .regularExpression) != nil else {
            throw NSError(domain: "RunlistAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: "Test bundle has no canonical Air job directory."])
        }
        let root = jobs.appendingPathComponent(String(components[0]), isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue,
              root.resolvingSymlinksInPath().path == root.path,
              bundle.resolvingSymlinksInPath().path == bundle.path else {
            throw NSError(domain: "RunlistAcceptance", code: 2, userInfo: [NSLocalizedDescriptionKey: "Air job directory must exist without symlinks."])
        }
        guard NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty else {
            throw NSError(domain: "RunlistAcceptance", code: 3, userInfo: [NSLocalizedDescriptionKey: "Runlist is already running. Refusing to attach to a user's app."])
        }
        fixture = root.appendingPathComponent("fixture", isDirectory: true)
        guard !FileManager.default.fileExists(atPath: fixture.path) else {
            throw NSError(domain: "RunlistAcceptance", code: 4, userInfo: [NSLocalizedDescriptionKey: "Fixture already exists. A qualification job is never reused."])
        }
        try FileManager.default.createDirectory(at: fixture.appendingPathComponent("docs/plans"), withIntermediateDirectories: true)
        document = fixture.appendingPathComponent("docs/plans/air-acceptance.md")
        try "export const root='docs';\n".write(to: fixture.appendingPathComponent("runlist.config.mjs"), atomically: false, encoding: .utf8)
        try ".runlist/\n".write(to: fixture.appendingPathComponent(".gitignore"), atomically: false, encoding: .utf8)
        try (prefix + originalBody).write(to: document, atomically: false, encoding: .utf8)
        try git(["init", "--initial-branch=main"])
        try git(["config", "core.hooksPath", "/dev/null"])
        try git(["add", ".gitignore", "runlist.config.mjs", "docs/plans/air-acceptance.md"])
        try git(["-c", "user.name=Runlist acceptance", "-c", "user.email=acceptance@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic acceptance fixture"])
        app = XCUIApplication(bundleIdentifier: bundleIdentifier)
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "Installed app did not launch.")
        let installed = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Runlist.app").resolvingSymlinksInPath()
        let running = try XCTUnwrap(NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first)
        appPID = running.processIdentifier
        XCTAssertEqual(running.bundleURL?.resolvingSymlinksInPath(), installed, "Launch selected a different application copy.")
        capture("launched")
    }

    override func tearDownWithError() throws {
        guard let app else { return }
        capture("before-quit")
        sampleOwnedProcesses()
        app.typeKey("q", modifierFlags: .command)
        let quit = app.wait(for: .notRunning, timeout: 10)
        XCTAssertTrue(quit, "Normal Quit did not stop the owned app.")
        let deadline = Date().addingTimeInterval(10)
        while ownedPIDs.contains(where: { kill($0, 0) == 0 }) && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        let remaining = ownedPIDs.filter { kill($0, 0) == 0 }
        XCTAssertTrue(remaining.isEmpty, "Owned helper descendants remain after Quit: \(remaining.sorted())")
        // A failed ordinary quit remains a failure even when XCTest must release its app.
        if !quit { app.terminate() }
        capture("after-quit")
    }

    func testInstalledWorkflowAndDialogAccessibility() throws {
        app.typeKey("o", modifierFlags: .command)
        let chooser = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in
            app.sheets.firstMatch.exists || app.dialogs.firstMatch.exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [chooser], timeout: 10), .completed, "Native folder chooser is absent.")
        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 5), "Go to Folder has no accessible location field.")
        location.typeText(fixture.path)
        app.typeKey(XCUIKeyboardKey.return.rawValue, modifierFlags: [])
        let open = app.buttons["Open"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.click()
        let trust = app.buttons["Trust and open"].firstMatch
        XCTAssertTrue(trust.waitForExistence(timeout: 10), "Native configuration trust confirmation is inaccessible.")
        capture("trust-confirmation")
        trust.click()
        let title = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Air acceptance")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 15), "Fixture document is absent from the native library tree.")
        title.click()
        let markdown = app.buttons["Edit Markdown"].firstMatch
        XCTAssertTrue(markdown.waitForExistence(timeout: 10))
        markdown.click()
        let editor = app.textViews["Markdown body"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "Markdown editor is not exposed to native accessibility.")
        editor.click()
        app.typeKey("a", modifierFlags: .command)
        editor.typeText(savedBody)
        let review = app.buttons.matching(NSPredicate(format: "label == %@", "Review changes")).firstMatch
        XCTAssertTrue(review.exists && review.isEnabled)
        review.click()
        let save = app.buttons["Save changes"].firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 10) && save.isEnabled)
        capture("save-review")
        save.click()
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate { [self] _, _ in
            (try? String(contentsOf: document, encoding: .utf8)) == prefix + savedBody
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 15), .completed, "Exact source readback differs after Save.")
        XCTAssertEqual(try Data(contentsOf: document), Data((prefix + savedBody).utf8))
        sampleOwnedProcesses()
        XCTAssertFalse(ownedPIDs.isEmpty, "No owned helper descendant was observed while the checkout was open.")
        capture("saved-readback")

        let lifecycle = app.buttons["Change status"].firstMatch
        XCTAssertTrue(lifecycle.waitForExistence(timeout: 5))
        lifecycle.click()
        capture("status-dialog")
        let status = app.popUpButtons["New status"].firstMatch
        let reason = app.textViews["Reason"].firstMatch
        let reviewStatus = app.buttons["Review status change"].firstMatch
        // Missing dialog controls are a failing native result, never a keyboard workaround.
        XCTAssertTrue(status.waitForExistence(timeout: 5), "Status dialog has no accessible New status control.")
        XCTAssertTrue(reason.exists, "Status dialog has no accessible Reason editor.")
        XCTAssertTrue(reviewStatus.exists, "Status dialog has no accessible review button.")
        let unreviewedApply = app.buttons["Apply status change"].firstMatch
        XCTAssertTrue(!unreviewedApply.exists || !unreviewedApply.isEnabled, "Apply must be unavailable before a reviewed result.")
        status.click()
        let paused = app.menuItems["paused"].firstMatch
        XCTAssertTrue(paused.waitForExistence(timeout: 5))
        paused.click()
        reason.click()
        reason.typeText("Native acceptance review.")
        reviewStatus.click()
        let apply = app.buttons["Apply status change"].firstMatch
        XCTAssertTrue(apply.waitForExistence(timeout: 10) && apply.isEnabled, "Successful fresh review did not enable Apply.")
        capture("reviewed-confirmation")
        XCTAssertEqual(try Data(contentsOf: document), Data((prefix + savedBody).utf8), "Review changed source before confirmation.")
        let close = app.buttons["Close status change"].firstMatch
        XCTAssertTrue(close.exists)
        close.click()
        XCTAssertFalse(apply.exists, "Closing the dialog left confirmation controls exposed.")
    }

    private func capture(_ name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        if let app {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = name + "-accessibility"
            tree.lifetime = .keepAlways
            add(tree)
        }
    }

    private func git(_ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = fixture
        var environment = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("GIT_") }
        environment["GIT_CONFIG_NOSYSTEM"] = "1"
        environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
        environment["GIT_TERMINAL_PROMPT"] = "0"
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "RunlistAcceptance", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(decoding: bytes, as: UTF8.self)])
        }
    }

    private func sampleOwnedProcesses() {
        guard let appPID else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid=,ppid="]
        let output = Pipe()
        process.standardOutput = output
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let rows = String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { row -> (pid_t, pid_t)? in
                let fields = row.split(whereSeparator: { $0.isWhitespace })
                guard fields.count == 2, let pid = pid_t(fields[0]), let parent = pid_t(fields[1]) else { return nil }
                return (pid, parent)
            }
            var parents: Set<pid_t> = [appPID]
            var count = -1
            while count != parents.count {
                count = parents.count
                for (pid, parent) in rows where parents.contains(parent) { parents.insert(pid) }
            }
            ownedPIDs.formUnion(parents.subtracting([appPID]))
        } catch { XCTFail("Cannot observe owned helper descendants: \(error)") }
    }
}
