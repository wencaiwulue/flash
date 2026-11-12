// OpenComputerUseHelper.swift
//
// Dependency-free macOS computer-use helper. Speaks newline-delimited JSON on
// stdin/stdout and uses only public Apple frameworks. Diagnostics go to stderr.

import AppKit
import ApplicationServices
import CoreGraphics
import CoreVideo
import Foundation
import ScreenCaptureKit

private typealias JSONObject = [String: Any]
private let maxRequestBytes = 8 * 1024 * 1024
private let maxPendingRequests = 64

private enum HelperError: LocalizedError {
    case invalid(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .failed(let message):
            return message
        }
    }
}

private func invalid(_ message: String) -> HelperError {
    .invalid(message)
}

private func failure(_ message: String) -> HelperError {
    .failed(message)
}

private func diagnostic(_ message: String) {
    let line = "[open-computer-use-helper] \(message)\n"
    if let data = line.data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

private func writeJSONLine(_ object: JSONObject) {
    do {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    } catch {
        // All internally generated values are JSON-safe. Keep stdout valid even
        // if an OS API unexpectedly returns a non-conforming value.
        let fallback = "{\"error\":\"Could not encode response\",\"ok\":false}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

private func params(_ request: JSONObject) throws -> JSONObject {
    guard let value = request["params"] else { return [:] }
    guard let result = value as? JSONObject else {
        throw invalid("params must be a JSON object")
    }
    return result
}

private func requiredString(_ p: JSONObject, _ key: String, maxLength: Int = 4096) throws -> String {
    guard let value = p[key] as? String, !value.isEmpty, value.count <= maxLength else {
        throw invalid("\(key) must be a non-empty string of at most \(maxLength) characters")
    }
    return value
}

private func requiredBool(_ p: JSONObject, _ key: String) throws -> Bool {
    guard let value = p[key] as? Bool else { throw invalid("\(key) must be a boolean") }
    return value
}

private func optionalBool(_ p: JSONObject, _ key: String, default defaultValue: Bool) throws -> Bool {
    guard p[key] != nil else { return defaultValue }
    return try requiredBool(p, key)
}

private func number(_ value: Any?, key: String) throws -> Double {
    guard let value, !(value is Bool), let number = value as? NSNumber else {
        throw invalid("\(key) must be a number")
    }
    let result = number.doubleValue
    guard result.isFinite else { throw invalid("\(key) must be finite") }
    return result
}

private func requiredNumber(_ p: JSONObject, _ key: String) throws -> Double {
    try number(p[key], key: key)
}

private func requiredInt(_ p: JSONObject, _ key: String, min: Int, max: Int) throws -> Int {
    let value = try requiredNumber(p, key)
    guard value.rounded() == value, value >= Double(min), value <= Double(max) else {
        throw invalid("\(key) must be an integer in \(min)...\(max)")
    }
    return Int(value)
}

private func optionalDisplayID(_ p: JSONObject, _ key: String = "displayId") throws -> CGDirectDisplayID? {
    guard p[key] != nil else { return nil }
    return CGDirectDisplayID(try requiredInt(p, key, min: 0, max: Int(UInt32.max)))
}

private func stringArray(_ p: JSONObject, _ key: String, required: Bool = true) throws -> [String] {
    guard let raw = p[key] else {
        if required { throw invalid("\(key) must be an array of strings") }
        return []
    }
    guard let array = raw as? [Any], array.count <= 512 else {
        throw invalid("\(key) must be an array with at most 512 items")
    }
    var result: [String] = []
    result.reserveCapacity(array.count)
    for item in array {
        guard let string = item as? String, !string.isEmpty, string.count <= 1024 else {
            throw invalid("\(key) must contain only non-empty strings")
        }
        result.append(string)
    }
    return result
}

private func finitePoint(_ p: JSONObject) throws -> CGPoint {
    let x = try requiredNumber(p, "x")
    let y = try requiredNumber(p, "y")
    guard abs(x) <= 10_000_000, abs(y) <= 10_000_000 else {
        throw invalid("coordinates are outside the supported range")
    }
    return CGPoint(x: x, y: y)
}

private struct DisplayInfo {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let scaleFactor: Double

    var json: JSONObject {
        [
            "displayId": NSNumber(value: id),
            "width": Double(bounds.width),
            "height": Double(bounds.height),
            "scaleFactor": scaleFactor,
            "originX": Double(bounds.origin.x),
            "originY": Double(bounds.origin.y),
        ]
    }
}

private final class DisplayManager {
    func all() throws -> [DisplayInfo] {
        var count: UInt32 = 0
        var error = CGGetActiveDisplayList(0, nil, &count)
        guard error == .success else { throw failure("CGGetActiveDisplayList failed (\(error.rawValue))") }
        if count == 0 { throw failure("No active displays") }
        count = min(count, 128)
        var ids = Array(repeating: CGDirectDisplayID(0), count: Int(count))
        var actualCount: UInt32 = 0
        error = CGGetActiveDisplayList(count, &ids, &actualCount)
        guard error == .success else { throw failure("CGGetActiveDisplayList failed (\(error.rawValue))") }
        ids = Array(ids.prefix(Int(actualCount)))
        return ids.map { info(for: $0) }
    }

    func get(_ requested: CGDirectDisplayID?) throws -> DisplayInfo {
        let id = requested ?? CGMainDisplayID()
        let displays = try all()
        guard let display = displays.first(where: { $0.id == id }) else {
            throw invalid("Unknown or inactive displayId \(id)")
        }
        return display
    }

    private func info(for id: CGDirectDisplayID) -> DisplayInfo {
        let bounds = CGDisplayBounds(id)
        var scale = 1.0
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        if let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[key] as? NSNumber)?.uint32Value == id
        }) {
            scale = Double(screen.backingScaleFactor)
        } else if bounds.width > 0 {
            let pixels = Double(CGDisplayPixelsWide(id))
            if pixels > 0 { scale = pixels / Double(bounds.width) }
        }
        if !scale.isFinite || scale <= 0 { scale = 1 }
        return DisplayInfo(id: id, bounds: bounds, scaleFactor: scale)
    }
}

private struct WindowRecord {
    let pid: pid_t
    let bounds: CGRect
}

private func windowRecords(onScreenOnly: Bool) -> [WindowRecord] {
    let options: CGWindowListOption = onScreenOnly
        ? [.optionOnScreenOnly, .excludeDesktopElements]
        : [.optionAll, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var result: [WindowRecord] = []
    result.reserveCapacity(raw.count)
    for window in raw {
        guard let pidNumber = window[kCGWindowOwnerPID as String] as? NSNumber else { continue }
        if let layer = window[kCGWindowLayer as String] as? NSNumber, layer.intValue != 0 { continue }
        if let alpha = window[kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue <= 0 { continue }
        guard let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              !bounds.isNull, !bounds.isInfinite,
              bounds.width >= 1, bounds.height >= 1 else { continue }
        result.append(WindowRecord(pid: pid_t(pidNumber.int32Value), bounds: bounds))
    }
    return result
}

private func regularApplications() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && $0.bundleIdentifier != nil
    }
}

private func appDescription(_ app: NSRunningApplication) -> JSONObject {
    [
        "bundleId": app.bundleIdentifier ?? "",
        "displayName": app.localizedName ?? app.bundleIdentifier ?? "Unknown",
    ]
}

private final class AppManager {
    private let displays: DisplayManager

    init(displays: DisplayManager) {
        self.displays = displays
    }

    func previewHideSet(_ p: JSONObject) throws -> [JSONObject] {
        let allowlist = Set(try stringArray(p, "allowlistBundleIds"))
        let displayID = try optionalDisplayID(p)
        return try hideCandidates(allowlist: allowlist, hostBundleID: nil, displayID: displayID).map(appDescription)
    }

    private func hideCandidates(
        allowlist: Set<String>,
        hostBundleID: String?,
        displayID: CGDirectDisplayID?
    ) throws -> [NSRunningApplication] {
        let windows = windowRecords(onScreenOnly: true)
        let displayBounds = try displayID.map { try displays.get($0).bounds }
        return regularApplications().filter { app in
            guard let bundleID = app.bundleIdentifier,
                  !allowlist.contains(bundleID), bundleID != hostBundleID,
                  !app.isHidden, !app.isTerminated else { return false }
            guard let displayBounds else { return true }
            let pid = app.processIdentifier
            return windows.contains { $0.pid == pid && $0.bounds.intersects(displayBounds) }
        }
    }

    @discardableResult
    func unhide(bundleIDs: [String], onlyIfRunning: Bool = true) throws -> [String] {
        let wanted = Set(bundleIDs)
        if wanted.isEmpty { return [] }
        var restored: [String] = []
        var errors: [String] = []
        for app in NSWorkspace.shared.runningApplications {
            guard let bundleID = app.bundleIdentifier, wanted.contains(bundleID) else { continue }
            if onlyIfRunning && app.isTerminated { continue }
            if app.unhide() {
                restored.append(bundleID)
            } else if !app.isHidden {
                restored.append(bundleID)
            } else {
                errors.append(bundleID)
            }
        }
        if !errors.isEmpty {
            throw failure("Could not unhide: \(errors.sorted().joined(separator: ", "))")
        }
        return restored
    }

    private func rollback(_ apps: [NSRunningApplication]) {
        for app in apps.reversed() where !app.isTerminated {
            if !app.unhide() {
                diagnostic("Rollback could not unhide \(app.bundleIdentifier ?? "unknown app")")
            }
        }
    }

    func prepareDisplay(_ p: JSONObject) throws -> JSONObject {
        let allowlist = Set(try stringArray(p, "allowlistBundleIds"))
        let host = try requiredString(p, "hostBundleId")
        let displayID = try optionalDisplayID(p)
        if let displayID { _ = try displays.get(displayID) }
        let candidates = try hideCandidates(allowlist: allowlist, hostBundleID: host, displayID: displayID)
        let previousFrontmost = NSWorkspace.shared.frontmostApplication
        var hiddenApps: [NSRunningApplication] = []
        var hiddenIDs: [String] = []
        do {
            for app in candidates {
                guard let bundleID = app.bundleIdentifier else { continue }
                guard app.hide() || app.isHidden else { throw failure("Could not hide \(bundleID)") }
                hiddenApps.append(app)
                hiddenIDs.append(bundleID)
            }

            var activated: String?
            let eligible = regularApplications().filter {
                guard let id = $0.bundleIdentifier else { return false }
                return allowlist.contains(id) && id != host && !$0.isHidden && !$0.isTerminated
            }
            var target: NSRunningApplication?
            if let frontmost = NSWorkspace.shared.frontmostApplication,
               eligible.contains(where: { $0.processIdentifier == frontmost.processIdentifier }) {
                target = frontmost
            }
            if target == nil, let displayID {
                let bounds = try displays.get(displayID).bounds
                let windows = windowRecords(onScreenOnly: true)
                target = eligible.first { app in
                    windows.contains { $0.pid == app.processIdentifier && $0.bounds.intersects(bounds) }
                }
            }
            target = target ?? eligible.first
            if let target, let bundleID = target.bundleIdentifier {
                guard target.activate(options: [.activateAllWindows]) else {
                    throw failure("Could not activate \(bundleID)")
                }
                activated = bundleID
            }
            var result: JSONObject = ["hidden": hiddenIDs]
            if let activated { result["activated"] = activated }
            return result
        } catch {
            rollback(hiddenApps)
            if let previousFrontmost, !previousFrontmost.isTerminated {
                _ = previousFrontmost.activate(options: [])
            }
            throw error
        }
    }

    func findWindowDisplays(_ p: JSONObject) throws -> [JSONObject] {
        let requested = try stringArray(p, "bundleIds")
        let active = try displays.all()
        let windows = windowRecords(onScreenOnly: false)
        let apps = NSWorkspace.shared.runningApplications
        return requested.map { bundleID in
            let pids = Set(apps.filter { $0.bundleIdentifier == bundleID }.map(\.processIdentifier))
            var ids: [NSNumber] = []
            for display in active {
                let found = windows.contains {
                    pids.contains($0.pid) && $0.bounds.intersects(display.bounds)
                }
                if found { ids.append(NSNumber(value: display.id)) }
            }
            return ["bundleId": bundleID, "displayIds": ids]
        }
    }

    func appUnderPoint(_ p: JSONObject) throws -> Any {
        let point = try finitePoint(p)
        let apps = NSWorkspace.shared.runningApplications
        for window in windowRecords(onScreenOnly: true) where window.bounds.contains(point) {
            guard let app = apps.first(where: { $0.processIdentifier == window.pid }),
                  let bundleID = app.bundleIdentifier else { continue }
            return [
                "bundleId": bundleID,
                "displayName": app.localizedName ?? bundleID,
            ]
        }
        return NSNull()
    }

    func listRunning() -> [JSONObject] {
        regularApplications().map(appDescription).sorted {
            ($0["displayName"] as? String ?? "").localizedCaseInsensitiveCompare(
                $1["displayName"] as? String ?? ""
            ) == .orderedAscending
        }
    }

    func listInstalled() -> [JSONObject] {
        var roots = [
            URL(fileURLWithPath: "/Applications", isDirectory: true),
            URL(fileURLWithPath: "/System/Applications", isDirectory: true),
        ]
        roots.append(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true))
        var appsByBundleID: [String: JSONObject] = [:]
        let fm = FileManager.default
        for root in roots where fm.fileExists(atPath: root.path) {
            guard let enumerator = fm.enumerator(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey, .localizedNameKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else { continue }
            for case let url as URL in enumerator {
                guard url.pathExtension == "app" else {
                    let relativeDepth = url.pathComponents.count - root.pathComponents.count
                    if relativeDepth >= 5 { enumerator.skipDescendants() }
                    continue
                }
                autoreleasepool {
                    guard let bundle = Bundle(url: url),
                          let bundleID = bundle.bundleIdentifier,
                          !bundleID.isEmpty else { return }
                    let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                        ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                        ?? url.deletingPathExtension().lastPathComponent
                    let item: JSONObject = [
                        "bundleId": bundleID,
                        "displayName": name,
                        "path": url.path,
                    ]
                    if appsByBundleID[bundleID] == nil { appsByBundleID[bundleID] = item }
                }
            }
        }
        return appsByBundleID.values.sorted {
            ($0["displayName"] as? String ?? "").localizedCaseInsensitiveCompare(
                $1["displayName"] as? String ?? ""
            ) == .orderedAscending
        }
    }

    func iconDataURL(_ p: JSONObject) throws -> Any {
        let path = try requiredString(p, "path", maxLength: 8192)
        guard FileManager.default.fileExists(atPath: path) else { return NSNull() }
        let icon = NSWorkspace.shared.icon(forFile: path)
        icon.size = NSSize(width: 128, height: 128)
        guard let tiff = icon.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return NSNull() }
        return "data:image/png;base64,\(png.base64EncodedString())"
    }

    func unhideRequest(_ p: JSONObject) throws -> JSONObject {
        _ = try unhide(bundleIDs: stringArray(p, "bundleIds"))
        return [:]
    }

    func open(_ p: JSONObject, completion: @escaping (Result<JSONObject, Error>) -> Void) {
        do {
            let bundleID = try requiredString(p, "bundleId")
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
                throw failure("No installed application with bundleId \(bundleID)")
            }
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error {
                    completion(.failure(failure("Could not open \(bundleID): \(error.localizedDescription)")))
                } else {
                    completion(.success([:]))
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    func automaticDisplay(allowlist: [String], fallback: CGDirectDisplayID) throws -> DisplayInfo {
        let all = try displays.all()
        let allowed = Set(allowlist)
        let pids = Set(NSWorkspace.shared.runningApplications.filter {
            guard let id = $0.bundleIdentifier else { return false }
            return allowed.contains(id)
        }.map(\.processIdentifier))
        let windows = windowRecords(onScreenOnly: true).filter { pids.contains($0.pid) }
        var best: DisplayInfo?
        var bestArea: CGFloat = 0
        for display in all {
            let area = windows.reduce(CGFloat(0)) { partial, window in
                partial + window.bounds.intersection(display.bounds).area
            }
            if area > bestArea {
                best = display
                bestArea = area
            }
        }
        return best ?? (all.first { $0.id == fallback } ?? all[0])
    }
}

private extension CGRect {
    var area: CGFloat {
        guard !isNull, !isInfinite else { return 0 }
        return max(0, width) * max(0, height)
    }
}

private final class ScreenshotManager {
    private let displays: DisplayManager

    init(displays: DisplayManager) {
        self.displays = displays
    }

    private func captureArguments(_ p: JSONObject) throws -> (allowed: [String], quality: Double, width: Int, height: Int) {
        let allowed = try stringArray(p, "allowedBundleIds")
        guard !allowed.isEmpty else { throw invalid("allowedBundleIds must not be empty") }
        let quality = try requiredNumber(p, "jpegQuality")
        guard (0...1).contains(quality) else { throw invalid("jpegQuality must be between 0 and 1") }
        let width = try requiredInt(p, "targetWidth", min: 1, max: 16384)
        let height = try requiredInt(p, "targetHeight", min: 1, max: 16384)
        guard width * height <= 100_000_000 else { throw invalid("target image dimensions are too large") }
        return (allowed, quality, width, height)
    }

    func capture(_ p: JSONObject, region: Bool, completion: @escaping (Result<JSONObject, Error>) -> Void) {
        do {
            let args = try captureArguments(p)
            guard CGPreflightScreenCaptureAccess() else {
                throw failure("Screen Recording permission is not granted")
            }
            let requestedID = try optionalDisplayID(p)
            var requestedRegion: CGRect?
            if region {
                let origin = try finitePoint(p)
                let width = try requiredNumber(p, "width")
                let height = try requiredNumber(p, "height")
                guard width > 0, height > 0, width <= 1_000_000, height <= 1_000_000 else {
                    throw invalid("region width and height must be positive and reasonably bounded")
                }
                requestedRegion = CGRect(x: origin.x, y: origin.y, width: width, height: height)
            }
            let display = try selectDisplay(requestedID: requestedID, region: requestedRegion)
            Task {
                do {
                    guard #available(macOS 14.0, *) else {
                        throw failure("ScreenCaptureKit screenshots require macOS 14 or newer")
                    }
                    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                    guard let scDisplay = content.displays.first(where: { $0.displayID == display.id }) else {
                        throw failure("Display \(display.id) is unavailable to ScreenCaptureKit")
                    }
                    let allowed = Set(args.allowed)
                    let applications = content.applications.filter { allowed.contains($0.bundleIdentifier) }
                    let filter = SCContentFilter(display: scDisplay, including: applications, exceptingWindows: [])
                    let configuration = SCStreamConfiguration()
                    configuration.width = args.width
                    configuration.height = args.height
                    configuration.pixelFormat = kCVPixelFormatType_32BGRA
                    configuration.showsCursor = false
                    configuration.scalesToFit = true
                    if let requestedRegion {
                        let local = requestedRegion.intersection(display.bounds).offsetBy(
                            dx: -display.bounds.origin.x,
                            dy: -display.bounds.origin.y
                        )
                        guard !local.isNull, !local.isInfinite, local.width > 0, local.height > 0 else {
                            throw invalid("Capture region does not intersect display \(display.id)")
                        }
                        configuration.sourceRect = local
                    }
                    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                    let bitmap = NSBitmapImageRep(cgImage: image)
                    guard let jpeg = bitmap.representation(
                        using: .jpeg,
                        properties: [.compressionFactor: NSNumber(value: args.quality)]
                    ) else { throw failure("Could not encode screenshot as JPEG") }
                    var result: JSONObject = [
                        "base64": jpeg.base64EncodedString(),
                        "width": image.width,
                        "height": image.height,
                    ]
                    if !region {
                        result["displayWidth"] = Double(display.bounds.width)
                        result["displayHeight"] = Double(display.bounds.height)
                        result["displayId"] = NSNumber(value: display.id)
                        result["originX"] = Double(display.bounds.origin.x)
                        result["originY"] = Double(display.bounds.origin.y)
                    }
                    let response = result
                    DispatchQueue.main.async { completion(.success(response)) }
                } catch {
                    DispatchQueue.main.async { completion(.failure(error)) }
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    private func selectDisplay(requestedID: CGDirectDisplayID?, region: CGRect?) throws -> DisplayInfo {
        if let requestedID { return try displays.get(requestedID) }
        guard let region else { return try displays.get(nil) }
        var best: DisplayInfo?
        var bestArea: CGFloat = 0
        for display in try displays.all() {
            let area = region.intersection(display.bounds).area
            if area > bestArea {
                best = display
                bestArea = area
            }
        }
        guard let best else { throw invalid("Capture region does not intersect an active display") }
        return best
    }
}

private final class InputManager {
    private let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
        "j": 38, "k": 40, "n": 45, "m": 46,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25,
        "7": 26, "8": 28, "0": 29,
        "command": 55, "cmd": 55, "meta": 55, "super": 55,
        "shift": 56, "option": 58, "alt": 58, "control": 59, "ctrl": 59,
        "rightcommand": 54, "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
        "function": 63, "fn": 63,
        "return": 36, "enter": 36, "keypadenter": 76, "tab": 48, "space": 49,
        "backspace": 51, "delete": 117, "forwarddelete": 117, "escape": 53, "esc": 53,
        "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
        "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79,
        "f19": 80, "f20": 90,
        "equal": 24, "=": 24, "minus": 27, "-": 27,
        "rightbracket": 30, "]": 30, "leftbracket": 33, "[": 33,
        "quote": 39, "'": 39, "semicolon": 41, ";": 41,
        "backslash": 42, "\\": 42, "comma": 43, ",": 43,
        "slash": 44, "/": 44, "period": 47, ".": 47, "grave": 50, "`": 50,
        "keypad0": 82, "keypad1": 83, "keypad2": 84, "keypad3": 85,
        "keypad4": 86, "keypad5": 87, "keypad6": 88, "keypad7": 89,
        "keypad8": 91, "keypad9": 92, "keypaddecimal": 65, "keypadmultiply": 67,
        "keypadplus": 69, "keypadclear": 71, "keypaddivide": 75,
        "keypadminus": 78, "keypadequals": 81,
    ]

    private func post(_ event: CGEvent?) throws {
        guard let event else { throw failure("Could not create CGEvent") }
        event.post(tap: .cghidEventTap)
    }

    func moveMouse(_ p: JSONObject) throws -> JSONObject {
        let target = try finitePoint(p)
        let animated = try optionalBool(p, "animated", default: false)
        if animated, let current = CGEvent(source: nil)?.location {
            let distance = hypot(target.x - current.x, target.y - current.y)
            let frames = min(30, max(1, Int((distance / 120).rounded())))
            for frame in 1...frames {
                let t = Double(frame) / Double(frames)
                let eased = 1 - pow(1 - t, 3)
                let point = CGPoint(
                    x: current.x + (target.x - current.x) * eased,
                    y: current.y + (target.y - current.y) * eased
                )
                try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
                if frame < frames { usleep(8_000) }
            }
        } else {
            try post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left))
        }
        return [:]
    }

    func mouseLocation() throws -> JSONObject {
        guard let location = CGEvent(source: nil)?.location else { throw failure("Could not read mouse location") }
        return ["x": Double(location.x), "y": Double(location.y)]
    }

    func mouseButton(_ p: JSONObject) throws -> JSONObject {
        let buttonName = try requiredString(p, "button", maxLength: 32).lowercased()
        let action = try requiredString(p, "action", maxLength: 32).lowercased()
        let count = p["count"] == nil ? 1 : try requiredInt(p, "count", min: 1, max: 3)
        let location = CGEvent(source: nil)?.location ?? .zero
        let downType: CGEventType
        let upType: CGEventType
        let button: CGMouseButton
        switch buttonName {
        case "left": downType = .leftMouseDown; upType = .leftMouseUp; button = .left
        case "right": downType = .rightMouseDown; upType = .rightMouseUp; button = .right
        case "middle": downType = .otherMouseDown; upType = .otherMouseUp; button = .center
        default: throw invalid("button must be left, right, or middle")
        }
        func event(type: CGEventType, click: Int) throws -> CGEvent {
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: location, mouseButton: button) else {
                throw failure("Could not create mouse event")
            }
            event.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            return event
        }
        switch action {
        case "press": try post(event(type: downType, click: count))
        case "release": try post(event(type: upType, click: count))
        case "click":
            for click in 1...count {
                try post(event(type: downType, click: click))
                try post(event(type: upType, click: click))
            }
        default: throw invalid("action must be click, press, or release")
        }
        return [:]
    }

    func mouseScroll(_ p: JSONObject) throws -> JSONObject {
        let raw = try requiredNumber(p, "amount")
        guard raw.rounded() == raw, raw >= Double(Int32.min), raw <= Double(Int32.max) else {
            throw invalid("amount must be a bounded integer")
        }
        let amount = Int32(raw)
        let axis = try requiredString(p, "axis", maxLength: 32).lowercased()
        let event: CGEvent?
        switch axis {
        case "vertical":
            event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: amount, wheel2: 0, wheel3: 0)
        case "horizontal":
            event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: amount, wheel3: 0)
        default: throw invalid("axis must be vertical or horizontal")
        }
        try post(event)
        return [:]
    }

    private func code(for name: String) throws -> CGKeyCode {
        let normalized = name.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: " ", with: "")
        guard let code = keyCodes[normalized] else { throw invalid("Unsupported keyName \(name)") }
        return code
    }

    func key(_ p: JSONObject) throws -> JSONObject {
        let name = try requiredString(p, "keyName", maxLength: 64)
        let action = try requiredString(p, "action", maxLength: 32).lowercased()
        let down: Bool
        switch action {
        case "press": down = true
        case "release": down = false
        default: throw invalid("action must be press or release")
        }
        try postKey(code(for: name), down: down)
        return [:]
    }

    private func postKey(_ code: CGKeyCode, down: Bool, unicode: [UInt16]? = nil) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
            throw failure("Could not create keyboard event")
        }
        event.flags = CGEventSource.flagsState(.hidSystemState)
        if let unicode {
            unicode.withUnsafeBufferPointer { buffer in
                event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
        }
        event.post(tap: .cghidEventTap)
    }

    func keys(_ p: JSONObject) throws -> JSONObject {
        let names = try stringArray(p, "keyNames")
        guard names.count <= 32 else { throw invalid("keyNames may contain at most 32 keys") }
        var pressed: [CGKeyCode] = []
        do {
            for name in names {
                let code = try code(for: name)
                try postKey(code, down: true)
                pressed.append(code)
                usleep(2_000)
            }
            for code in pressed.reversed() {
                try? postKey(code, down: false)
                usleep(2_000)
            }
        } catch {
            for code in pressed.reversed() { try? postKey(code, down: false) }
            throw error
        }
        return [:]
    }

    func typeText(_ p: JSONObject) throws -> JSONObject {
        guard let text = p["text"] as? String, text.count <= 100_000 else {
            throw invalid("text must be a string of at most 100000 characters")
        }
        guard text.utf8.count <= 1_000_000 else { throw invalid("text is too large") }
        for character in text {
            let units = Array(String(character).utf16)
            try postKey(0, down: true, unicode: units)
            do {
                try postKey(0, down: false, unicode: units)
            } catch {
                try? postKey(0, down: false, unicode: units)
                throw error
            }
        }
        return [:]
    }

    func frontmostAppInfo() -> Any {
        guard let app = NSWorkspace.shared.frontmostApplication else { return NSNull() }
        var result: JSONObject = ["appName": app.localizedName ?? "Unknown"]
        if let bundleID = app.bundleIdentifier { result["bundleId"] = bundleID }
        return result
    }
}

private final class HotkeyManager {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var expectedEscapeUntil = 0.0
    var onEscape: (() -> Void)?

    var registered: Bool { tap != nil }

    func register() -> Bool {
        if tap != nil { return true }
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let newTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: openComputerUseEscapeCallback,
            userInfo: context
        ), let newSource = CFMachPortCreateRunLoopSource(nil, newTap, 0) else {
            return false
        }
        tap = newTap
        source = newSource
        CFRunLoopAddSource(CFRunLoopGetMain(), newSource, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        return true
    }

    func unregister() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            CFRunLoopSourceInvalidate(source)
        }
        source = nil
        tap = nil
        expectedEscapeUntil = 0
    }

    func notifyExpectedEscape() {
        expectedEscapeUntil = ProcessInfo.processInfo.systemUptime + 0.150
    }

    fileprivate func handle(_ event: CGEvent, type: CGEventType) -> CGEvent? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return event
        }
        guard type == .keyDown || type == .keyUp else { return event }
        guard event.getIntegerValueField(.keyboardEventKeycode) == 53 else { return event }
        let combination = event.flags.intersection([
            .maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn,
        ])
        guard combination.isEmpty else { return event }
        if ProcessInfo.processInfo.systemUptime <= expectedEscapeUntil { return event }
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            onEscape?()
        }
        return nil
    }
}

private let openComputerUseEscapeCallback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let manager = Unmanaged<HotkeyManager>.fromOpaque(userInfo).takeUnretainedValue()
    guard let result = manager.handle(event, type: type) else { return nil }
    return Unmanaged.passUnretained(result)
}

private final class ComputerUseService {
    let displays = DisplayManager()
    lazy var apps = AppManager(displays: displays)
    lazy var screenshots = ScreenshotManager(displays: displays)
    let input = InputManager()
    let hotkey = HotkeyManager()

    func handle(method: String, p: JSONObject, completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            switch method {
            case "display.getSize":
                completion(.success(try displays.get(optionalDisplayID(p)).json))
            case "display.listAll":
                completion(.success(try displays.all().map(\.json)))
            case "apps.previewHideSet":
                completion(.success(try apps.previewHideSet(p)))
            case "apps.prepareDisplay":
                completion(.success(try apps.prepareDisplay(p)))
            case "apps.findWindowDisplays":
                completion(.success(try apps.findWindowDisplays(p)))
            case "apps.appUnderPoint":
                completion(.success(try apps.appUnderPoint(p)))
            case "apps.listInstalled":
                completion(.success(apps.listInstalled()))
            case "apps.iconDataUrl":
                completion(.success(try apps.iconDataURL(p)))
            case "apps.listRunning":
                completion(.success(apps.listRunning()))
            case "apps.unhide":
                completion(.success(try apps.unhideRequest(p)))
            case "apps.open":
                apps.open(p) { result in completion(result.map { $0 as Any }) }
            case "tcc.checkAccessibility":
                completion(.success(["granted": AXIsProcessTrusted()]))
            case "tcc.checkScreenRecording":
                completion(.success(["granted": CGPreflightScreenCaptureAccess()]))
            case "hotkey.registerEscape":
                completion(.success(["registered": hotkey.register()]))
            case "hotkey.unregister":
                hotkey.unregister()
                completion(.success([:]))
            case "hotkey.notifyExpectedEscape":
                hotkey.notifyExpectedEscape()
                completion(.success([:]))
            case "screenshot.captureExcluding":
                screenshots.capture(p, region: false) { result in completion(result.map { $0 as Any }) }
            case "screenshot.captureRegion":
                screenshots.capture(p, region: true) { result in completion(result.map { $0 as Any }) }
            case "resolvePrepareCapture":
                resolvePrepareCapture(p, completion: completion)
            case "drainMainRunLoop":
                completion(.success(drainMainRunLoop()))
            case "input.moveMouse":
                completion(.success(try input.moveMouse(p)))
            case "input.mouseButton":
                completion(.success(try input.mouseButton(p)))
            case "input.mouseScroll":
                completion(.success(try input.mouseScroll(p)))
            case "input.mouseLocation":
                completion(.success(try input.mouseLocation()))
            case "input.key":
                completion(.success(try input.key(p)))
            case "input.keys":
                completion(.success(try input.keys(p)))
            case "input.typeText":
                completion(.success(try input.typeText(p)))
            case "input.getFrontmostAppInfo":
                completion(.success(input.frontmostAppInfo()))
            default:
                throw invalid("Unknown method \(method)")
            }
        } catch {
            completion(.failure(error))
        }
    }

    private func resolvePrepareCapture(_ p: JSONObject, completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            let allowed = try stringArray(p, "allowedBundleIds")
            let host = try requiredString(p, "hostBundleId")
            _ = try requiredNumber(p, "jpegQuality")
            _ = try requiredInt(p, "targetWidth", min: 1, max: 16384)
            _ = try requiredInt(p, "targetHeight", min: 1, max: 16384)
            let preferred = try optionalDisplayID(p, "preferredDisplayId")
            let autoResolve = try requiredBool(p, "autoResolve")
            let doHide = try optionalBool(p, "doHide", default: true)
            let display: DisplayInfo
            if let preferred {
                display = try displays.get(preferred)
            } else if autoResolve {
                display = try apps.automaticDisplay(allowlist: allowed, fallback: CGMainDisplayID())
            } else {
                display = try displays.get(nil)
            }

            var captureParams = p
            captureParams["displayId"] = NSNumber(value: display.id)
            var hidden: [String] = []
            var activated: String?
            let previousFrontmost = doHide ? NSWorkspace.shared.frontmostApplication : nil
            if doHide {
                let prepare: JSONObject = [
                    "allowlistBundleIds": allowed,
                    "hostBundleId": host,
                    "displayId": NSNumber(value: display.id),
                ]
                let prepared = try apps.prepareDisplay(prepare)
                hidden = prepared["hidden"] as? [String] ?? []
                activated = prepared["activated"] as? String
            }
            screenshots.capture(captureParams, region: false) { [weak self] result in
                switch result {
                case .success(var screenshot):
                    screenshot["hidden"] = hidden
                    if let activated { screenshot["activated"] = activated }
                    completion(.success(screenshot))
                case .failure(let captureError):
                    if !hidden.isEmpty {
                        do {
                            _ = try self?.apps.unhide(bundleIDs: hidden)
                        } catch {
                            diagnostic("Capture rollback failed: \(error.localizedDescription)")
                        }
                    }
                    if let previousFrontmost, !previousFrontmost.isTerminated {
                        _ = previousFrontmost.activate(options: [])
                    }
                    completion(.failure(captureError))
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    private func drainMainRunLoop() -> JSONObject {
        let start = ProcessInfo.processInfo.systemUptime
        var drained = 0
        while drained < 16 && ProcessInfo.processInfo.systemUptime - start < 0.025 {
            let before = Date(timeIntervalSinceNow: 0.001)
            _ = RunLoop.main.run(mode: .default, before: before)
            drained += 1
        }
        return ["drained": drained]
    }
}

private final class ProtocolDriver {
    private let service = ComputerUseService()
    private var pending: [Data] = []
    private var processing = false
    private var inputEnded = false
    private var oversizedInput = false

    init() {
        service.hotkey.onEscape = { writeJSONLine(["event": "escape"]) }
    }

    func start() {
        Thread.detachNewThread { [weak self] in
            self?.readStandardInput()
        }
    }

    private func readStandardInput() {
        var buffer = Data()
        let handle = FileHandle.standardInput
        while true {
            let chunk = handle.readData(ofLength: 64 * 1024)
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer.prefix(upTo: newline))
                buffer.removeSubrange(...newline)
                if oversizedInput {
                    oversizedInput = false
                } else {
                    enqueue(line)
                }
            }
            if buffer.count > maxRequestBytes {
                buffer.removeAll(keepingCapacity: true)
                oversizedInput = true
                enqueueError(id: "", message: "Request exceeds \(maxRequestBytes) bytes")
            }
        }
        if !buffer.isEmpty && !oversizedInput {
            enqueue(buffer)
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.inputEnded = true
            self.finishIfPossible()
        }
    }

    private func enqueue(_ line: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.pending.count >= maxPendingRequests {
                let id = (try? JSONSerialization.jsonObject(with: line) as? JSONObject)??["id"] as? String ?? ""
                self.respond(id: id, result: .failure(invalid("Too many pending requests")))
                return
            }
            self.pending.append(line)
            self.processNext()
        }
    }

    private func enqueueError(id: String, message: String) {
        DispatchQueue.main.async {
            self.respond(id: id, result: .failure(invalid(message)))
        }
    }

    private func processNext() {
        guard !processing, !pending.isEmpty else { return }
        processing = true
        let data = pending.removeFirst()
        let id = ((try? JSONSerialization.jsonObject(with: data) as? JSONObject)??["id"] as? String) ?? ""
        do {
            guard !data.isEmpty, data.count <= maxRequestBytes else {
                throw invalid("Request is empty or too large")
            }
            let raw = try JSONSerialization.jsonObject(with: data, options: [])
            guard let request = raw as? JSONObject else { throw invalid("Request must be a JSON object") }
            guard let requestID = request["id"] as? String, !requestID.isEmpty, requestID.count <= 4096 else {
                throw invalid("id must be a non-empty string")
            }
            guard let method = request["method"] as? String, !method.isEmpty, method.count <= 256 else {
                throw invalid("method must be a non-empty string")
            }
            let requestParams = try params(request)
            service.handle(method: method, p: requestParams) { [weak self] result in
                guard let self else { return }
                self.respond(id: requestID, result: result)
                self.processing = false
                self.processNext()
                self.finishIfPossible()
            }
        } catch {
            respond(id: id, result: .failure(error))
            processing = false
            processNext()
        }
    }

    private func respond(id: String, result: Result<Any, Error>) {
        switch result {
        case .success(let value):
            writeJSONLine(["id": id, "ok": true, "result": value])
        case .failure(let error):
            writeJSONLine(["id": id, "ok": false, "error": error.localizedDescription])
        }
    }

    private func finishIfPossible() {
        guard inputEnded, !processing, pending.isEmpty else { return }
        service.hotkey.unregister()
        // RunLoop.run() can resume after CFRunLoopStop when AppKit has other
        // sources installed. At EOF every queued request is complete, so a
        // direct, deterministic process exit is the appropriate CLI behavior.
        exit(0)
    }
}

private let usage = """
OpenComputerUseHelper — public-API macOS computer-use JSON-lines helper

Usage: open-computer-use-helper

The helper takes no command-line arguments. Send one JSON object per line:
  {"id":"1","method":"display.listAll","params":{}}

Responses are written to stdout. Diagnostics are written to stderr. Physical
bare Escape emits {"event":"escape"} while hotkey.registerEscape is active.
Screen capture requires macOS 14 or newer and existing Screen Recording
permission. Input injection and event taps require Accessibility permission;
the helper never requests either permission itself.
"""

if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--help" {
    print(usage)
    exit(0)
}
if CommandLine.arguments.count != 1 {
    FileHandle.standardError.write(Data("Usage: open-computer-use-helper [--help]\n".utf8))
    exit(64)
}

_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
private let driver = ProtocolDriver()
driver.start()
RunLoop.main.run()
