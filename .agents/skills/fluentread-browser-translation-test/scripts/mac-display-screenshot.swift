// Capture a single extended macOS display by its current ID and exact name.
import AppKit
import ScreenCaptureKit

func stop(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3,
      let displayID = CGDirectDisplayID(CommandLine.arguments[1]) else {
    stop("Expected display ID and exact name")
}
guard #available(macOS 14.0, *) else {
    stop("ScreenCaptureKit still images require macOS 14 or later")
}
guard CGPreflightScreenCaptureAccess() else {
    stop("Screen & System Audio Recording permission is required for display screenshots")
}
let name = CommandLine.arguments[2]
let screens = NSScreen.screens.filter { $0.localizedName == name }
guard screens.count == 1,
      let id = screens[0].deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
      id.uint32Value == displayID,
      CGDisplayIsMain(displayID) == 0,
      CGDisplayIsInMirrorSet(displayID) == 0 else {
    stop("The named extended display is unavailable or its identity changed")
}

do {
    let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true
    )
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
        stop("The requested display is unavailable to ScreenCaptureKit")
    }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
    configuration.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
    configuration.showsCursor = false
    let image = try await withCheckedThrowingContinuation { (reply: CheckedContinuation<CGImage, Error>) in
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
            if let image {
                reply.resume(returning: image)
            } else {
                reply.resume(throwing: error ?? CocoaError(.fileReadUnknown))
            }
        }
    }
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        stop("Could not encode the display capture as PNG")
    }
    FileHandle.standardOutput.write(png)
} catch {
    stop("ScreenCaptureKit: \(error)")
}
