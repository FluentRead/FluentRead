//
//  ViewController.swift
//  流畅阅读
//
//  容器应用只做三件事：展示启用状态、引导用户在 Safari 中授权、跳转到 Safari 扩展设置。
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "com.fluentread.safari.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    /// 引导页按 560pt 宽的卡片排版；窗口过窄会把三步步进说明压成多行。
    private let cardContentSize = NSSize(width: 560, height: 620)

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.configuration.userContentController.add(self, name: "controller")
        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        guard let window = view.window else { return }
        window.title = "流畅阅读"
        window.contentMinSize = NSSize(width: 480, height: 520)
        window.setContentSize(cardContentSize)
        window.center()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            DispatchQueue.main.async {
                // 未安装、未签名被拒或查询失败时状态未知，仍要让页面显示引导步骤而不是停在“检查中”。
                guard let state = state, error == nil else {
                    webView.evaluateJavaScript("show(null, true)")
                    return
                }
                webView.evaluateJavaScript("show(\(state.isEnabled), true)")
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String, body == "open-preferences" else { return }

        // 打开系统设置前先退出，避免设置窗口被本应用盖住（转换器默认行为）。
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }

}
