import AppKit
import Darwin
import Security
import XCTest

final class RunlistAcceptanceTests: XCTestCase {
    private let bundleIdentifier = "dev.reowens.runlist"
    private var app: XCUIApplication!
    private var fixture: URL!
    private var document: URL!
    private var accountHome: URL!
    private var prefix = ""
    private var originalBody = ""
    private var savedBody = ""
    private struct FixtureSpec: Decodable {
        let schemaVersion: Int
        let prefix: String
        let originalBody: String
        let savedBody: String
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let account = getpwuid(getuid()), let home = account.pointee.pw_dir else {
            throw NSError(domain: "RunlistAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: "Account home is unavailable."])
        }
        accountHome = URL(fileURLWithPath: String(cString: home), isDirectory: true)
        let bundle = Bundle(for: RunlistAcceptanceTests.self).bundleURL.standardizedFileURL
        let jobsSuffix = "/native-projects/runlist/jobs/"
        guard bundle.path.hasPrefix(accountHome.path + "/"),
              let boundary = bundle.path.range(of: jobsSuffix),
              String(bundle.path[..<boundary.lowerBound]).hasSuffix("-worker.noindex") else {
            throw NSError(domain: "RunlistAcceptance", code: 1, userInfo: [NSLocalizedDescriptionKey: "Test bundle is outside the worker jobs directory."])
        }
        let jobs = URL(fileURLWithPath: String(bundle.path[..<boundary.upperBound].dropLast()), isDirectory: true)
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
        guard FileManager.default.fileExists(atPath: fixture.appendingPathComponent(".git").path),
              fixture.resolvingSymlinksInPath().path == fixture.path else {
            throw NSError(domain: "RunlistAcceptance", code: 4, userInfo: [NSLocalizedDescriptionKey: "The admitted worker did not prepare the isolated fixture."])
        }
        let spec = try JSONDecoder().decode(FixtureSpec.self, from: Data(contentsOf: root.appendingPathComponent("fixture-spec.json")))
        XCTAssertEqual(spec.schemaVersion, 1)
        prefix = spec.prefix
        originalBody = spec.originalBody
        savedBody = spec.savedBody
        document = fixture.appendingPathComponent("docs/plans/air-acceptance.md")
        XCTAssertEqual(try Data(contentsOf: document), Data((prefix + originalBody).utf8), "Prepared fixture differs from its bound specification.")
        app = XCUIApplication(bundleIdentifier: bundleIdentifier)
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "Installed app did not launch.")
        let installed = accountHome.appendingPathComponent("Applications/Runlist.app").resolvingSymlinksInPath()
        let running = try XCTUnwrap(NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first)
        let launched = try XCTUnwrap(running.bundleURL?.resolvingSymlinksInPath())
        XCTAssertTrue(launched == installed || launched.path.contains("/AppTranslocation/"), "Launch selected an unexpected application location.")
        XCTAssertEqual(try signedCodeIdentity(launched), try signedCodeIdentity(installed), "Launched code differs from the selected personally signed application.")
        capture("launched")
    }

    override func tearDownWithError() throws {
        continueAfterFailure = true
        guard let app else { return }
        defer { if app.state != .notRunning { app.terminate() } }
        capture("before-quit")
        let pickerCancel = app.sheets["open-panel"].buttons["CancelButton"].firstMatch
        if pickerCancel.exists && pickerCancel.isHittable { pickerCancel.click() }
        let trustCancel = app.sheets.matching(NSPredicate(format: "label == %@", "alert")).buttons["action-button-2"].firstMatch
        if trustCancel.exists && trustCancel.isHittable { trustCancel.click() }
        app.typeKey("q", modifierFlags: .command)
        let quit = app.wait(for: .notRunning, timeout: 10)
        XCTAssertTrue(quit, "Normal Quit did not stop the owned app.")
        // A failed ordinary quit remains a failure even when XCTest must release its app.
        if !quit { app.terminate() }
        capture("after-quit")
        // Each case shares the worker's disposable fixture. Restore only the
        // exact edit authored by this harness, so case order cannot hide a failure.
        if let document, !prefix.isEmpty,
           try Data(contentsOf: document) == Data((prefix + savedBody).utf8) {
            try Data((prefix + originalBody).utf8).write(to: document, options: .atomic)
        }
    }

    private func openFixtureDocument() throws {
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
        let open = app.sheets["open-panel"].buttons["OKButton"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.click()
        let trust = app.sheets.matching(NSPredicate(format: "label == %@", "alert")).buttons.matching(NSPredicate(format: "identifier == %@ AND title == %@", "action-button-1", "Trust and open")).firstMatch
        XCTAssertTrue(trust.waitForExistence(timeout: 10), "Native configuration trust confirmation is inaccessible.")
        capture("trust-confirmation")
        trust.click()
        let title = app.buttons.matching(NSPredicate(format: "title BEGINSWITH %@ AND title CONTAINS %@", "Air acceptance ", "docs/plans/air-acceptance.md")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 15), "Fixture document is absent from the native library tree.")
        title.click()
        XCTAssertTrue(app.buttons["Change status"].firstMatch.waitForExistence(timeout: 10))
    }

    func testStatusDialogAccessibilityWithoutEditing() throws {
        try openFixtureDocument()
        capture("before-status-dialog")
        app.buttons["Change status"].firstMatch.click()
        defer { capture("focused-status-dialog") }
        let status = app.popUpButtons["New status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5), "Status dialog has no accessible New status control before any edit or save.")
        XCTAssertTrue(app.textViews["Reason"].firstMatch.exists, "Status dialog has no accessible Reason editor.")
        XCTAssertTrue(app.buttons["Review status change"].firstMatch.exists, "Status dialog has no accessible review button.")
        let apply = app.buttons["Apply status change"].firstMatch
        XCTAssertTrue(!apply.exists || !apply.isEnabled, "Apply must be unavailable before a reviewed result.")
        let close = app.buttons["Close status change"].firstMatch
        XCTAssertTrue(close.exists && close.isEnabled)
        capture("focused-status-controls")
        close.click()
        XCTAssertTrue(app.buttons["Change status"].firstMatch.waitForExistence(timeout: 5), "Closing the dialog did not restore the document controls.")
        XCTAssertFalse(status.exists, "Closing the dialog left its status control exposed.")
        XCTAssertEqual(try Data(contentsOf: document), Data((prefix + originalBody).utf8), "Opening and closing the dialog changed source.")
    }

    func testTemplatesDialogAccessibilityWithoutEditing() throws {
        try openFixtureDocument()
        let templates = app.buttons["Templates"].firstMatch
        XCTAssertTrue(templates.waitForExistence(timeout: 5) && templates.isHittable)
        capture("before-templates-dialog")
        templates.click()
        defer { capture("focused-templates-dialog") }
        let editor = app.textViews["Template Markdown"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "Templates dialog has no accessible Markdown editor before any edit or save.")
        XCTAssertTrue(app.buttons["Review template changes"].firstMatch.exists, "Templates dialog has no accessible review button.")
        let close = app.buttons["Close templates"].firstMatch
        XCTAssertTrue(close.exists && close.isEnabled)
        capture("focused-template-controls")
        close.click()
        XCTAssertTrue(templates.waitForExistence(timeout: 5), "Closing Templates did not restore the surrounding controls.")
        XCTAssertFalse(editor.exists, "Closing Templates left its editor exposed.")
        XCTAssertEqual(try Data(contentsOf: document), Data((prefix + originalBody).utf8), "Opening and closing Templates changed document source.")
    }

    func testInstalledWorkflowAndDialogAccessibility() throws {
        try openFixtureDocument()
        let details = app.buttons["Details"].firstMatch
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        details.click()
        let evidence = app.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", "FILE & EVIDENCE")).firstMatch
        XCTAssertTrue(evidence.waitForExistence(timeout: 5))
        evidence.click()
        let markdown = app.buttons["Edit Markdown"].firstMatch
        XCTAssertTrue(markdown.waitForExistence(timeout: 10))
        markdown.click()
        let editor = app.textViews["Markdown body"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "Markdown editor is not exposed to native accessibility.")
        editor.typeKey("a", modifierFlags: .command)
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

    private func signedCodeIdentity(_ url: URL) throws -> Data {
        var code: SecStaticCode?
        var requirement: SecRequirement?
        let text = "anchor apple generic and certificate leaf[subject.OU] = \"7GSPYYN5X8\" and identifier \"dev.reowens.runlist\""
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate), requirement) == errSecSuccess else {
            throw NSError(domain: "RunlistAcceptance", code: 5, userInfo: [NSLocalizedDescriptionKey: "Application is not the valid personally signed Runlist bundle."])
        }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let identity = (information as NSDictionary?)?[kSecCodeInfoUnique] as? Data else {
            throw NSError(domain: "RunlistAcceptance", code: 6, userInfo: [NSLocalizedDescriptionKey: "Application code identity is unavailable."])
        }
        return identity
    }
}
