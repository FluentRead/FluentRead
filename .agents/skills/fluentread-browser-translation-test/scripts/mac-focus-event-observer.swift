/**
 * @file scripts/testing/mac-focus-event-observer.swift
 * 文件职责：只读监听 macOS 工作区应用激活事件，为隔离浏览器验证提供连续证据。
 * 主要内容：注册原生 NSWorkspace 通知后才发送 ready，以 JSON 行记录应用 PID、名称、墙钟与单调时间；标准输入关闭或 stop 指令只结束本观察器。
 * 模块边界：不启动、激活、隐藏或关闭任何应用，不读取窗口标题、网页或用户文档，也不发送系统输入；进程由调用者单独创建和回收。
 */
import AppKit
import Foundation

func emit(_ record: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { exit(2) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
func times() -> [String: Any] {
    return ["time": Date().timeIntervalSince1970 * 1000, "monotonicMs": ProcessInfo.processInfo.systemUptime * 1000]
}
let center = NSWorkspace.shared.notificationCenter
let observer = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notification in
    guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { exit(3) }
    var record = times()
    record["kind"] = "activation"
    record["pid"] = Int(app.processIdentifier)
    record["name"] = app.localizedName ?? ""
    emit(record)
}
// 保持 observer 与 run loop 存活；监听注册成功后 ready 才允许调用者启动浏览器。
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty || String(data: data, encoding: .utf8)?.contains("stop") == true {
        DispatchQueue.main.async { exit(0) }
    }
}
var ready = times()
ready["kind"] = "ready"
ready["pid"] = Int(ProcessInfo.processInfo.processIdentifier)
emit(ready)
RunLoop.main.run()
withExtendedLifetime(observer) {}
