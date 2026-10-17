// Production-only public XCTest plan. Each case runs separately on owned A407; identities remain externally bound.
// No diagnostic Popup/DOM execution, fake cue/cache, provider changes, permission grants, rotation or background matrix.
import XCTest
import UIKit

final class SafariSmokeTests: XCTestCase {
    let udid = "A407390F-7AA8-42AE-AFEB-F93EE99E9FF8"
    let url = "https://m.youtube.com/watch?v=iG9CE55wbtY"
    var began = Date()
    var actions: [String:Int] = [:]
    override func setUpWithError() throws {
        continueAfterFailure = false; began = Date()
        #if !targetEnvironment(simulator)
        throw NSError(domain:"ProductionResearchSafety",code:1)
        #endif
        let e = ProcessInfo.processInfo.environment
        guard e["FLUENTREAD_UI_APPROVED"] == "1", e["SIMULATOR_UDID"] == udid,
              e["FLUENTREAD_ARTIFACT_KIND"] == "production",
              e["FLUENTREAD_PRODUCTION_IDENTITY_SHA256"]?.count == 64,
              e["FLUENTREAD_EXPECTED_WEB_RAW"]?.count == 64,
              e["FLUENTREAD_EXPECTED_WEB_RAW"] != "50c33842c9595bff21eff0b9eaeb0c1bb79d08c3ef371ab3476fe304cf8b8ea2",
              e["FLUENTREAD_PRODUCTION_IDENTITY_SHA256"] != "a13a50f6d97c6516501190ccd33a7d0241e5e06cb68eb2d9bd455ab06e97d089" else {
            throw NSError(domain:"ProductionResearchSafety",code:2)
        }
    }
    func json(_ object: Any, _ name: String) {
        let a = XCTAttachment(data:try! JSONSerialization.data(withJSONObject:object,options:[.prettyPrinted,.sortedKeys]),uniformTypeIdentifier:"public.json")
        a.name=name; a.lifetime = .keepAlways; add(a)
    }
    func rect(_ r: CGRect) -> [String:CGFloat] { ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
    func nodes(_ n: any XCUIElementSnapshot) -> [any XCUIElementSnapshot] { [n]+n.children.flatMap { nodes($0) } }
    @discardableResult func evidence(_ app: XCUIApplication, _ name: String) -> (any XCUIElementSnapshot)? {
        let shot=XCTAttachment(screenshot:XCUIScreen.main.screenshot());shot.name=name;shot.lifetime = .keepAlways;add(shot)
        do {
            let tree=try app.snapshot()
            json(["elapsedSeconds":Date().timeIntervalSince(began),"nodes":nodes(tree).map { n -> [String:Any] in
                ["label":n.label,"identifier":n.identifier,"type":n.elementType.rawValue,"frame":rect(n.frame),"selected":n.isSelected,
                 "valueType":n.value.map { String(reflecting:type(of:$0)) } ?? "nil", "valueString":(n.value as? String).map { $0 as Any } ?? NSNull()]
            }],name+"-actual-AX")
            return tree
        } catch { json(["error":String(describing:error),"screenshotPreserved":true],name+"-AX-error");return nil }
    }
    func limited(_ app: XCUIApplication, _ reason: String) throws -> Never {
        json(["outcome":"UNVERIFIED","reason":reason,"actions":actions],"outcome");evidence(app,"unverified-final");throw XCTSkip(reason)
    }
    func guardUI(_ app: XCUIApplication) throws {
        guard Date().timeIntervalSince(began)<180, app.state == .runningForeground, app.alerts.count == 0 else {
            try limited(app,"Unexpected alert/app state or180s case budget; no permission decision")
        }
    }
    func ready(_ e: XCUIElement, _ timeout: TimeInterval = 3) -> Bool {
        if e.exists { return e.isHittable };return e.waitForExistence(timeout:timeout)&&e.isHittable
    }
    func wait(_ seconds: TimeInterval) {
        let start=Date();let x=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in Date().timeIntervalSince(start)>=seconds },object:nil)
        _=XCTWaiter.wait(for:[x],timeout:seconds+0.5)
    }
    func tap(_ e: XCUIElement, _ key: String) { actions[key,default:0]+=1;e.tap() }
    func candidate(_ app: XCUIApplication) -> XCUIElement {
        app.webViews.otherElements.matching(NSPredicate(format:"label BEGINSWITH %@ OR label BEGINSWITH %@","Do schools kill creativity? | Sir Ken Robinson | TED,","Ken Robinson认为学校扼杀创造力, ")).firstMatch
    }
    func player(_ app: XCUIApplication) -> XCUIElement { app.webViews.otherElements["YouTube 视频播放器"] }
    func navigate(_ app: XCUIApplication) throws {
        app.activate();guard app.wait(for:.runningForeground,timeout:10) else { try limited(app,"Owned Safari not foreground") }
        print("FR_PRODUCTION_SAFARI_ACTIVATED");try guardUI(app)
        let address=app.textFields["TabBarItemTitle"];guard ready(address) else { try limited(app,"Address control unavailable") };tap(address,"address")
        let editor=app.textFields["URL"];guard ready(editor) else { try limited(app,"URL editor unavailable") }
        let clear=app.buttons["ClearTextButton"];let exists=clear.exists
        if exists { guard clear.isHittable else { try limited(app,"Actual Clear not hittable") };tap(clear,"normalClear") }
        else { let value=editor.value as? String;let placeholder=editor.placeholderValue
            guard value == "" || (placeholder.map { !$0.isEmpty && value == $0 } ?? false) else { try limited(app,"No Clear and no actual empty/placeholder state; no append") }
        }
        let value=editor.value
        json(["clearExisted":exists,"valueType":value.map { String(reflecting:type(of:$0)) } ?? "nil","valueString":(value as? String).map { $0 as Any } ?? NSNull(),"placeholderValue":editor.placeholderValue.map { $0 as Any } ?? NSNull()],"address-after-clear")
        actions["navigation",default:0]+=1;editor.typeText(url+"\n")
        guard candidate(app).waitForExistence(timeout:25),player(app).exists else { try limited(app,"Known actual TED candidate/player unavailable") }
        try guardUI(app)
        let unmute=app.webViews.descendants(matching:.any).matching(NSPredicate(format:"label == %@","点按取消静音"))
        if unmute.count==1,unmute.firstMatch.isHittable,player(app).frame.intersects(unmute.firstMatch.frame) { tap(unmute.firstMatch,"siteUnmute") }
    }
    func showControlsOnce(_ app: XCUIApplication, _ key: String) throws {
        try guardUI(app);guard actions[key,default:0]==0 else { try limited(app,"Control reveal already used for "+key) }
        let named=app.webViews.buttons["显示播放器控件"]
        if named.exists&&named.isHittable { tap(named,key);return }
        let p=player(app);guard p.exists,p.isHittable,!p.frame.isEmpty,app.frame.contains(p.frame) else { try limited(app,"Current player normal touch target unavailable") }
        actions[key,default:0]+=1;p.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)).tap()
    }
    func prepareCCAndPlayback(_ app: XCUIApplication) throws {
        // Existing granted free runtime is used as configured. These actual site actions do not change provider/grants.
        let full=app.webViews.buttons["进入全屏模式"]
        if !full.exists || !full.isHittable { try showControlsOnce(app,"preparationControlReveal") }
        let cc=app.webViews.switches.matching(NSPredicate(format:"label CONTAINS %@ AND NOT label BEGINSWITH %@","字幕","流畅阅读"))
        var ccState="unknown"
        if cc.count==1 {
            let c=cc.firstMatch;ccState=c.value as? String ?? "unknown"
            if ccState=="0"&&c.isHittable { tap(c,"siteCCOn") }
        }
        let play=app.webViews.buttons["播放视频"]
        if play.exists&&play.isHittable { tap(play,"sitePlay") }
        json(["siteCCBefore":ccState,"actions":actions,"pauseRequested":false,"providerChanged":false,"permissionRequested":false],"normal-site-preparation")
    }
    func cue(_ tree: any XCUIElementSnapshot) -> [String:Any]? {
        let all=nodes(tree)
        let panels=all.filter {$0.label=="流畅阅读双语视频字幕"}
        let sources=all.filter {$0.label=="YouTube 整段原文字幕"}
        let translations=all.filter {$0.label=="流畅阅读视频字幕译文"}
        guard panels.count==1,sources.count==1,translations.count==1 else { return nil }
        let p=panels[0],s=sources[0],t=translations[0]
        let source=nodes(s).filter {$0.elementType == .staticText}.map(\.label).joined(separator:" ").trimmingCharacters(in:.whitespacesAndNewlines)
        let translation=nodes(t).filter {$0.elementType == .staticText}.map(\.label).joined(separator:" ").trimmingCharacters(in:.whitespacesAndNewlines)
        guard !source.isEmpty,!translation.isEmpty,source != translation,
              source.range(of:"[A-Za-z]",options:.regularExpression) != nil,translation.range(of:"[\\p{Han}]",options:.regularExpression) != nil,
              [p,s,t].allSatisfy({ !$0.frame.isEmpty && $0.frame.width>0 && $0.frame.height>0 }) else { return nil }
        return ["source":source,"translation":translation,"panel":rect(p.frame),"sourceFrame":rect(s.frame),"translationFrame":rect(t.frame),"panelX":p.frame.minX,"panelY":p.frame.minY,"panelW":p.frame.width,"panelH":p.frame.height]
    }
    func waitForRealBilingual(_ app: XCUIApplication, _ name: String) throws -> [String:Any] {
        let deadline=Date().addingTimeInterval(40)
        repeat {
            try guardUI(app)
            if let tree=try? app.snapshot(),let current=cue(tree) { json(current,name+"-readiness");evidence(app,name);return current }
            wait(min(1,max(0,deadline.timeIntervalSinceNow)))
        } while Date()<deadline
        try limited(app,"No actual nonempty English/Chinese source+translation with positive panel/source/translation frames within40s; intro or provider/source unavailable")
    }
    func recordCaptionControlRelation(_ app: XCUIApplication, _ tree: any XCUIElementSnapshot, _ name: String) {
        let all=nodes(tree);let data=cue(tree);let panel=all.first {$0.label=="流畅阅读双语视频字幕"}?.frame
        let controls=all.filter { !$0.frame.isEmpty && (($0.elementType == .slider && $0.label.contains("进度")) || ["查看章节","暂停视频","播放视频"].contains($0.label) || ($0.elementType == .staticText && $0.label.range(of:"^[0-9]+:[0-9]{2}",options:.regularExpression) != nil)) }
        json(["cue":data.map {$0 as Any} ?? NSNull(),"controls":controls.map { n -> [String:Any] in
            let intersection=panel?.intersection(n.frame) ?? .null
            return ["label":n.label,"frame":rect(n.frame),"intersectionArea":intersection.isNull ? 0 : intersection.width*intersection.height]
        },"visualAcceptance":"Screenshot manual review required; missing cue/controls is unverified; AX geometry alone is not paint/hit proof"],name)
    }
    func observeOptionalFRMenu(_ app: XCUIApplication) {
        let entries=app.webViews.descendants(matching:.any).matching(NSPredicate(format:"label BEGINSWITH %@","流畅阅读字幕翻译："))
        var r:[String:Any]=["blocking":false,"opened":false,"entryCount":entries.count]
        defer { r["actions"]=actions;json(r,"A-optional-FR-menu") }
        guard entries.count==1 else { r["reason"]="Actual entry unavailable/ambiguous";return }
        let e=entries.firstMatch;r["frame"]=rect(e.frame);r["atLeast44px"]=e.frame.width>=44&&e.frame.height>=44
        guard e.isHittable else { r["reason"]="Actual entry not hittable";return }
        tap(e,"FRMenuOpen");let close=app.webViews.buttons["关闭字幕菜单"]
        let opened=close.waitForExistence(timeout:3);r["opened"]=opened;evidence(app,"A-FR-menu-after-one-tap")
        if opened&&close.isHittable { tap(close,"FRMenuClose");r["closeObserved"]=close.waitForNonExistence(timeout:3) }
        else { r["reason"]="One actual entry tap did not establish open menu; no alternative gesture" }
    }
    struct A9Scene {
        let capturedAt: Date
        let appFrame: CGRect
        let playerFrame: CGRect
        let candidateLabel: String
        let nativeLabels: [String]
        let entryCount: Int
        let entryLabel: String
        let entryType: XCUIElement.ElementType
        let entryFrame: CGRect
        let closeCount: Int
        let closeType: XCUIElement.ElementType
        let closeFrame: CGRect
        let playback: [String:Any]
    }
    func a9Positive(_ frame: CGRect) -> Bool {
        !frame.isNull && !frame.isInfinite && frame.width > 0 && frame.height > 0 &&
        [frame.minX,frame.minY,frame.width,frame.height].allSatisfy { $0.isFinite }
    }
    func a9Frame(_ frame: CGRect) -> Any {
        guard [frame.minX,frame.minY,frame.width,frame.height].allSatisfy({ $0.isFinite }) else {
            return ["nonFinite":true,"isNull":frame.isNull,"isInfinite":frame.isInfinite]
        }
        return rect(frame)
    }
    func a9Scene(_ app: XCUIApplication, _ tree: any XCUIElementSnapshot, _ phase: String, _ capturedAt: Date) throws -> A9Scene {
        // All ownership and geometry below come from this ONE immutable snapshot, not live element calls.
        let all=nodes(tree)
        let players=all.filter { $0.elementType == .other && $0.label == "YouTube 视频播放器" }
        let frame=players.count == 1 ? players[0].frame : CGRect.null
        let candidates=all.filter { $0.elementType == .other && ($0.label.hasPrefix("Do schools kill creativity? | Sir Ken Robinson | TED,") || $0.label.hasPrefix("Ken Robinson认为学校扼杀创造力, ")) }
        let known=candidates.count == 1 && a9Positive(candidates[0].frame) && frame.contains(candidates[0].frame)
        let native=all.filter { $0.elementType == .button && ["暂停视频","播放视频","进入全屏模式"].contains($0.label) && a9Positive($0.frame) && frame.contains($0.frame) }
        // Exact production Chinese states; Safari may expose the HTML button as Other.
        let entryLabels=["流畅阅读字幕翻译：已开启","流畅阅读字幕翻译：已关闭","流畅阅读字幕翻译：流畅阅读总开关已关闭"]
        let entries=all.filter { ($0.elementType == .button || $0.elementType == .other) && entryLabels.contains($0.label) }
        let entryFrame=entries.count == 1 ? entries[0].frame : CGRect.null
        let closers=all.filter { ($0.elementType == .button || $0.elementType == .other || $0.elementType == .menuItem) && $0.label == "关闭字幕菜单" }
        let closeFrame=closers.count == 1 ? closers[0].frame : CGRect.null
        let progress=all.filter { a9Positive($0.frame) && frame.contains($0.frame) && (($0.elementType == .slider && $0.label.contains("进度")) || ($0.elementType == .staticText && $0.label.range(of:"^[0-9]+:[0-9]{2}",options:.regularExpression) != nil)) }
        let playback:[String:Any]=["pauseCount":native.filter { $0.label == "暂停视频" }.count,
                                  "playCount":native.filter { $0.label == "播放视频" }.count,
                                  "progress":progress.map { ["label":$0.label,"frame":a9Frame($0.frame),"value":$0.value.map { String(describing:$0) } ?? ""] as [String:Any] }]
        let eligible=players.count == 1 && known && a9Positive(frame) && a9Positive(tree.frame) && tree.frame.contains(frame)
        json(["phase":phase,"snapshotElapsedSeconds":capturedAt.timeIntervalSince(began),"metadataElapsedSeconds":Date().timeIntervalSince(began),
              "oneSnapshotBatch":true,"playerCount":players.count,"candidateCount":candidates.count,"knownTEDWithinPlayer":known,
              "appFrame":a9Frame(tree.frame),"playerFrame":a9Frame(frame),"baseBoundaryEligible":eligible,
              "nativeLabels":native.map { $0.label },"entryCount":entries.count,"entryLabel":entries.count == 1 ? entries[0].label : "",
              "entryType":entries.count == 1 ? entries[0].elementType.rawValue : 0,
              "entryFrame":a9Frame(entryFrame),"closeCount":closers.count,
              "closeType":closers.count == 1 ? closers[0].elementType.rawValue : 0,"closeFrame":a9Frame(closeFrame),
              "playback":playback,"optionalBilingualCue":cue(tree).map { $0 as Any } ?? NSNull()],"A9-scene-"+phase)
        guard eligible else { try limited(app,"A9 single-snapshot knownTED/unique-player/frame boundary unavailable; no action") }
        return A9Scene(capturedAt:capturedAt,appFrame:tree.frame,playerFrame:frame,candidateLabel:candidates[0].label,
                       nativeLabels:native.map { $0.label },entryCount:entries.count,entryLabel:entries.count == 1 ? entries[0].label : "",
                       entryType:entries.count == 1 ? entries[0].elementType : .any,entryFrame:entryFrame,
                       closeCount:closers.count,closeType:closers.count == 1 ? closers[0].elementType : .any,closeFrame:closeFrame,playback:playback)
    }
    func a9Snapshot(_ app: XCUIApplication, _ phase: String) throws -> A9Scene {
        try guardUI(app)
        guard let tree=try? app.snapshot() else { try limited(app,"A9 single snapshot unavailable; no retry") }
        return try a9Scene(app,tree,phase,Date())
    }
    func a9PrepareMenuScene(_ app: XCUIApplication, notAfter deadline: Date? = nil) throws -> A9Scene {
        try guardUI(app)
        guard actions["A9LivePlayerCenterTouch",default:0] == 0 else { try limited(app,"A9 whole-case coordinate touch already consumed") }
        guard let tree=evidence(app,"A9-before-possible-live-touch") else { try limited(app,"A9 required pre-touch image/AX unavailable") }
        if deadline != nil && menuScrollOwnedTabIDs(tree) != ["87246FAF-A680-4738-BA2A-97A9E170620D"] {
            try limited(app,"Readiness reveal pre-touch snapshot changed retained owner; no touch")
        }
        let scene=try a9Scene(app,tree,"before-possible-touch",Date())
        if deadline != nil && scene.entryCount>0 { return scene } // Readiness must not reveal over an existing exact entry.
        if !scene.nativeLabels.isEmpty {
            json(["decision":"nativeControlsAlreadyPresentInSnapshot","diagnosticTouchCount":0],"A9-coordinate-decision")
            return scene
        }
        // The known TED title can localize while the same player remains in place.
        let players=app.descendants(matching:.other).matching(NSPredicate(format:"label == %@","YouTube 视频播放器"))
        let playerCount=players.count
        let current=players.element
        let currentFrame=playerCount == 1 ? current.frame : CGRect.null
        let currentAppFrame=app.frame
        let candidates=app.descendants(matching:.other).matching(NSPredicate(format:"label BEGINSWITH %@ OR label BEGINSWITH %@",
            "Do schools kill creativity? | Sir Ken Robinson | TED,","Ken Robinson认为学校扼杀创造力, "))
        let candidateCount=candidates.count
        let candidateFrame=candidateCount == 1 ? candidates.element.frame : CGRect.null
        let currentCandidateLabel=candidateCount == 1 ? candidates.element.label : ""
        let stillKnown=candidateCount == 1 && a9Positive(candidateFrame) && currentFrame.contains(candidateFrame)
        let containerHittable=playerCount == 1 ? current.isHittable : false
        let currentFramePositive=a9Positive(currentFrame)
        let samePlayerFrame=currentFrame == scene.playerFrame
        let appFramePositive=a9Positive(currentAppFrame)
        let playerWithinApp=currentAppFrame.contains(currentFrame)
        json(["playerCount":playerCount,"candidateCount":candidateCount,"stillKnown":stillKnown,
              "currentCandidateLabel":currentCandidateLabel,"candidateFrame":a9Frame(candidateFrame),
              "candidateFramePositive":a9Positive(candidateFrame),"candidateWithinPlayer":currentFrame.contains(candidateFrame),
              "currentFrame":a9Frame(currentFrame),"evidencePlayerFrame":a9Frame(scene.playerFrame),
              "currentFramePositive":currentFramePositive,"samePlayerFrame":samePlayerFrame,
              "appFrame":a9Frame(currentAppFrame),"appFramePositive":appFramePositive,"playerWithinApp":playerWithinApp,
              "containerIsHittableObservationOnly":containerHittable,"elapsedSeconds":Date().timeIntervalSince(began)],"A9-pre-touch-premises")
        guard playerCount == 1,stillKnown,currentFramePositive,samePlayerFrame,appFramePositive,playerWithinApp else { try limited(app,"A9 pre-touch identity/frame prerequisite failed; see recorded individual premises; no gesture") }
        try guardUI(app)
        json(["decision":"oneCurrentElementRelativeCenterTouch","frame":rect(currentFrame),"appFrame":rect(currentAppFrame),
              "containerIsHittableObservationOnly":containerHittable,"normalizedX":0.5,"normalizedY":0.5],"A9-coordinate-decision")
        if let deadline=deadline {
            guard Date()<deadline else { try limited(app,"Shared readiness deadline exhausted during native AX reads; no center touch") }
        }
        actions["A9LivePlayerCenterTouch",default:0] += 1
        current.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)).tap()
        // One immediate observation batch. No CC chain, screenshot or polling before the FR button.
        return try a9Snapshot(app,"immediate-after-touch")
    }
    func a9ExactSemanticControl(_ app: XCUIApplication, label: String, type: XCUIElement.ElementType) throws -> XCUIElement {
        guard type == .button || type == .other || (label == "关闭字幕菜单" && type == .menuItem) else { try limited(app,"A9 unobserved semantic control type; no fallback") }
        // The snapshot's exact observed type and complete label; .element enforces uniqueness.
        return app.descendants(matching:type).matching(NSPredicate(format:"label == %@",label)).element
    }
    func a9ClosePresence(_ app: XCUIApplication) -> XCUIElement {
        // Read-only close existence across its three allowed types; never used for an action.
        app.descendants(matching:.any).matching(NSPredicate(format:"label == %@ AND (elementType == %d OR elementType == %d OR elementType == %d)",
            "关闭字幕菜单",XCUIElement.ElementType.button.rawValue,XCUIElement.ElementType.other.rawValue,XCUIElement.ElementType.menuItem.rawValue)).element
    }
    func a9PlayingMenu(_ app: XCUIApplication, scene: A9Scene) throws {
        var result:[String:Any]=["opened":false,"closeObserved":false,"entryCount":scene.entryCount,"beforeOpenPlayback":scene.playback]
        defer { result["actions"]=actions;json(result,"A9-menu-result") }
        guard !scene.nativeLabels.isEmpty else { try limited(app,"A9 immediate snapshot has no same-player native controls; no reveal retry") }
        guard scene.entryCount == 1,a9Positive(scene.entryFrame),scene.entryFrame.width >= 44,scene.entryFrame.height >= 44,
              scene.playerFrame.contains(scene.entryFrame) else { try limited(app,"A9 snapshot FR entry uniqueness/44px/same-player boundary unavailable") }
        let entry=try a9ExactSemanticControl(app,label:scene.entryLabel,type:scene.entryType)
        result["entryLabel"]=scene.entryLabel;result["entryType"]=scene.entryType.rawValue
        let actualFrame=entry.frame
        let hittable=entry.isHittable
        result["snapshotEntryFrame"]=rect(scene.entryFrame);result["actualEntryFrame"]=a9Frame(actualFrame)
        result["atLeast44px"]=actualFrame.width >= 44 && actualFrame.height >= 44
        result["entryIsHittable"]=hittable;result["entryContainedInPlayer"]=scene.playerFrame.contains(actualFrame)
        result["snapshotToEntryCheckSeconds"]=Date().timeIntervalSince(scene.capturedAt)
        guard a9Positive(actualFrame),actualFrame.width >= 44,actualFrame.height >= 44,scene.playerFrame.contains(actualFrame),hittable else { try limited(app,"A9 actual FR button frame/hit boundary unavailable; no fallback") }
        try guardUI(app)
        tap(entry,"FRMenuOpen")
        // Preserve the original3s appearance budget before inspecting the actual close type.
        let closePresence=a9ClosePresence(app)
        guard closePresence.waitForExistence(timeout:3) else { try limited(app,"A9 exact semantic close did not appear within3s") }
        let openedScene=try a9Snapshot(app,"after-entry-tap")
        guard openedScene.closeCount == 1,a9Positive(openedScene.closeFrame),openedScene.playerFrame.contains(openedScene.closeFrame) else { try limited(app,"A9 snapshot unique same-player close unavailable") }
        let close=try a9ExactSemanticControl(app,label:"关闭字幕菜单",type:openedScene.closeType)
        result["closeType"]=openedScene.closeType.rawValue
        guard close.isHittable else { try limited(app,"A9 normal entry tap did not expose a unique hittable menu close") }
        result["opened"]=true
        guard let menuTree=evidence(app,"A9-menu-after-one-normal-tap") else { try limited(app,"A9 menu original image/AX unavailable") }
        let menuScene=try a9Scene(app,menuTree,"menu-open",Date())
        result["menuAXCaptured"]=true;result["menuOpenPlayback"]=menuScene.playback
        // Owned menu is open: one bounded read-only follow-up may establish actual playback progression.
        let firstMenuRead=Date()
        wait(0.5)
        let later=try a9Snapshot(app,"menu-open-later-read")
        result["laterMenuReadElapsedSeconds"]=Date().timeIntervalSince(firstMenuRead)
        result["menuLaterPlayback"]=later.playback;result["menuStillOpenInLaterSnapshot"]=later.closeCount == 1
        guard later.closeCount == 1,a9Positive(later.closeFrame),later.playerFrame.contains(later.closeFrame) else { try limited(app,"A9 later menu close ownership/frame unavailable") }
        let currentClose=try a9ExactSemanticControl(app,label:"关闭字幕菜单",type:later.closeType)
        result["finalCloseType"]=later.closeType.rawValue
        let actualCloseFrame=currentClose.frame
        let closeHittable=currentClose.isHittable
        result["closeFrame"]=a9Frame(actualCloseFrame);result["closeContainedInPlayer"]=later.playerFrame.contains(actualCloseFrame)
        result["closeIsHittable"]=closeHittable
        guard a9Positive(actualCloseFrame),later.playerFrame.contains(actualCloseFrame),closeHittable else { try limited(app,"A9 actual close frame/hit boundary unavailable; no fallback") }
        try guardUI(app)
        tap(currentClose,"FRMenuClose")
        let closed=closePresence.waitForNonExistence(timeout:3);result["closeObserved"]=closed
        guard closed else { try limited(app,"A9 normal menu close not observed; no retry") }
    }
    // One independently selected case. The A9 helpers remain unchanged and are not a navigation permission.
    func menuScrollOwnedTabIDs(_ tree: any XCUIElementSnapshot) -> [String] {
        let prefix="TabDocument?"
        return Array(Set(nodes(tree).filter { $0.identifier.hasPrefix(prefix) }.map { node in
            let query=String(node.identifier.dropFirst(prefix.count))
            let fields=query.components(separatedBy:"&").filter { $0.hasPrefix("UUID=") }
            // Strip only the exact documented prefix; UUID may be the first query field.
            guard fields.count==1 else { return "INVALID_TAB_DOCUMENT_UUID_QUERY" }
            return String(fields[0].dropFirst(5))
        })).sorted()
    }
    func menuScrollTree(_ app: XCUIApplication, _ tree: any XCUIElementSnapshot, _ phase: String) throws -> (CGRect,[any XCUIElementSnapshot]) {
        let owner="87246FAF-A680-4738-BA2A-97A9E170620D"
        guard menuScrollOwnedTabIDs(tree)==[owner] else { try limited(app,"Current exact retained owned tab changed; no tab selection or navigation") }
        let scene=try a9Scene(app,tree,"scroll-"+phase,Date())
        let menus=nodes(tree).filter { $0.label=="流畅阅读视频字幕翻译菜单" && ($0.elementType == .other || $0.elementType == .menu) }
        guard menus.count==1,a9Positive(menus[0].frame),scene.playerFrame.contains(menus[0].frame),tree.frame.contains(menus[0].frame) else {
            try limited(app,"Unique current owned menu/frame unavailable; no coordinate fallback")
        }
        return (menus[0].frame,nodes(menus[0]))
    }
    // Additional read-only readiness evidence only. No navigation, media control or reveal action here.
    func menuObserveEntryReadiness(_ app: XCUIApplication, _ phase: String, until deadline: Date, maximumSamples: Int, observedEntry: inout Bool) throws -> A9Scene? {
        var observations:[[String:Any]]=[]
        defer { json(["phase":phase,"maximumSamples":maximumSamples,"deadlineElapsedSeconds":deadline.timeIntervalSince(began),
                      "observations":observations,"actions":actions,"productAcceptance":false],"menu-readiness-"+phase+"-summary") }
        for index in 0..<maximumSamples {
            try guardUI(app)
            guard Date()<deadline else { return nil }
            let started=Date(),name="menu-readiness-"+phase+"-"+String(index+1)
            // evidence() saves an original screenshot then one actual AX snapshot, in that order; not an atomic image/AX pair.
            guard let tree=evidence(app,name) else { try limited(app,"Readiness original image/AX unavailable; no fallback") }
            guard menuScrollOwnedTabIDs(tree)==["87246FAF-A680-4738-BA2A-97A9E170620D"] else {
                try limited(app,"Readiness exact retained tab ownership changed; no tab selection or navigation")
            }
            let scene=try a9Scene(app,tree,"readiness-"+phase+"-"+String(index+1),Date())
            observedEntry = observedEntry || scene.entryCount>0
            guard scene.entryCount<=1,scene.closeCount==0 else { try limited(app,"Readiness entry ambiguous or menu already open; no action") }
            if scene.entryCount==1 && scene.entryLabel != "流畅阅读字幕翻译：已开启" {
                try limited(app,"Readiness observed non-enabled exact entry; no setting change or reveal")
            }
            let snapshotEligible=scene.entryCount==1 && scene.entryLabel=="流畅阅读字幕翻译：已开启" &&
                a9Positive(scene.entryFrame) && scene.entryFrame.width>=44 && scene.entryFrame.height>=44 &&
                scene.playerFrame.contains(scene.entryFrame)
            var actualCount=0,actualFrame=CGRect.null,hittable=false
            if snapshotEligible {
                let query=app.descendants(matching:scene.entryType).matching(NSPredicate(format:"label == %@",scene.entryLabel))
                actualCount=query.count
                guard actualCount<=1 else { try limited(app,"Readiness current exact entry ambiguous; no action") }
                if actualCount==1 {
                    let entry=query.element
                    actualFrame=entry.frame;hittable=entry.exists && entry.isHittable
                    if entry.frame != actualFrame { hittable=false }
                }
            }
            try guardUI(app)
            let withinDeadline=Date()<deadline
            let currentEligible=snapshotEligible && actualCount==1 && actualFrame==scene.entryFrame && hittable && withinDeadline
            observations.append(["index":index+1,"captureStartedElapsedSeconds":started.timeIntervalSince(began),
                "completedElapsedSeconds":Date().timeIntervalSince(began),"screenshotThenSnapshot":true,
                "entryCount":scene.entryCount,"entryLabel":scene.entryLabel,"entryFrame":a9Frame(scene.entryFrame),
                "actualEntryCount":actualCount,"actualEntryFrame":a9Frame(actualFrame),"actualEntryHittable":hittable,
                "snapshotEligible":snapshotEligible,"withinObservationDeadline":withinDeadline,
                "readyEntryPreconditionOnly":currentEligible,"nativeLabels":scene.nativeLabels,"playbackObservation":scene.playback])
            if currentEligible { return scene }
            let remaining=deadline.timeIntervalSinceNow
            if index+1<maximumSamples && remaining>0 { wait(min(0.75,remaining)) }
        }
        return nil
    }
    func testPausedMenuScrollAndClose() throws {
        let app=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari")
        var result:[String:Any]=["scope":"one menu open / one native internal scroll / timing reachability / normal close / original-pixel focus review",
            "navigation":0,"createdTabs":0,"selectedTabs":0,"permissionChoices":0,"providerChanges":0,"explicitTranslationIntent":0,
            "playbackRequired":false,"bilingualRequired":false,"focusReturn":"PENDING_ORIGINAL_PIXEL_REVIEW"]
        defer { result["actions"]=actions;json(result,"menu-scroll-result") }
        app.activate();guard app.wait(for:.runningForeground,timeout:10) else { try limited(app,"Owned Safari not foreground") }
        print("FR_PRODUCTION_SAFARI_ACTIVATED");try guardUI(app)
        guard let initial=evidence(app,"menu-scroll-01-owned-before-open") else { try limited(app,"Owned initial image/AX unavailable") }
        guard menuScrollOwnedTabIDs(initial)==["87246FAF-A680-4738-BA2A-97A9E170620D"] else {
            try limited(app,"Current tab is not retained exact owner; no navigation or unknown-tab action")
        }
        let first=try a9Scene(app,initial,"scroll-initial",Date())
        // One shared24s observation window inside the existing absolute180s scene deadline; sample caps4+6.
        let readinessEnd=min(began.addingTimeInterval(180),Date().addingTimeInterval(24))
        result["readinessWindowEndElapsedSeconds"]=readinessEnd.timeIntervalSince(began)
        result["readinessIsProductAcceptance"]=false
        var observedExactEntry=first.entryCount>0
        var readyScene=try menuObserveEntryReadiness(app,"before-reveal",until:min(readinessEnd,Date().addingTimeInterval(6)),maximumSamples:4,observedEntry:&observedExactEntry)
        result["exactEntryObservedBeforeReveal"]=observedExactEntry
        if readyScene == nil {
            guard !observedExactEntry else { try limited(app,"An exact entry was observed but not ready; preserve no-reveal rule for existing entry") }
            guard Date()<readinessEnd else { try limited(app,"Shared readiness observation deadline exhausted; no reveal action") }
            // Existing helper may consume one normal center reveal only when native controls are absent. No Play/CC/unmute.
            let immediate=try a9PrepareMenuScene(app,notAfter:readinessEnd)
            result["immediateAfterExistingRevealPlayback"]=immediate.playback
            readyScene=try menuObserveEntryReadiness(app,"after-reveal",until:readinessEnd,maximumSamples:6,observedEntry:&observedExactEntry)
        }
        guard let scene=readyScene else {
            result["readinessStatus"]="UNVERIFIED_ENTRY_PRECONDITION_AFTER_BOUNDED_READ_ONLY_OBSERVATIONS"
            try limited(app,"Unique enabled same-player44px hittable entry unavailable within bounded readiness observation; no reveal retry")
        }
        result["readinessStatus"]="ENTRY_PRECONDITION_OBSERVED_ONLY_CONTINUING_ORIGINAL_MENU_ASSERTIONS"
        result["observedPlaybackBeforeOpen"]=scene.playback
        result["pausedStateObserved"]=(scene.playback["playCount"] as? Int)==1 && (scene.playback["pauseCount"] as? Int)==0
        guard scene.entryCount==1,scene.entryLabel=="流畅阅读字幕翻译：已开启",scene.closeCount==0,
              a9Positive(scene.entryFrame),scene.entryFrame.width>=44,scene.entryFrame.height>=44,
              scene.playerFrame.contains(scene.entryFrame) else { try limited(app,"Unique enabled same-player44px entry unavailable") }
        let entry=try a9ExactSemanticControl(app,label:scene.entryLabel,type:scene.entryType)
        guard entry.exists,entry.isHittable,a9Positive(entry.frame),entry.frame.width>=44,entry.frame.height>=44,
              scene.playerFrame.contains(entry.frame) else { try limited(app,"Current actual entry frame/hit unavailable") }
        try guardUI(app);tap(entry,"FRMenuOpen")
        let closePresence=a9ClosePresence(app)
        guard closePresence.waitForExistence(timeout:3),let beforeTree=evidence(app,"menu-scroll-02-before-internal-scroll") else {
            try limited(app,"Normal menu open/required original image unavailable; no retry")
        }
        let (menuFrame,beforeNodes)=try menuScrollTree(app,beforeTree,"before")
        let timingLabels=["提前 0.5 秒","延后 0.5 秒"]
        let beforeTiming=beforeNodes.filter { timingLabels.contains($0.label) && $0.elementType == .menuItem }
        guard beforeTiming.count==2,Set(beforeTiming.map(\.label))==Set(timingLabels) else { try limited(app,"Actual timing controls unavailable; no inferred bottom target") }
        let beforeTitle=beforeNodes.filter { $0.label=="字幕时间" && $0.elementType == .staticText }
        guard beforeTitle.count==1 else { try limited(app,"Actual unique timing row title unavailable") }
        let interactive=beforeNodes.filter { [.button,.menuItem,.slider,.switch,.textField,.searchField,.link].contains($0.elementType) && a9Positive($0.frame) }
        let startY=menuFrame.minY+menuFrame.height*0.85,endY=menuFrame.minY+menuFrame.height*0.25
        guard menuFrame.height>=100,startY-endY>=48 else { try limited(app,"Owned menu has no bounded internal scroll length") }
        // Only the actual thin padding gutter may start a scroll; reject any control intersection, not a guessed webview center.
        let channels=[menuFrame.minX+3,menuFrame.maxX-3].filter { x in
            let corridor=CGRect(x:x-1,y:endY,width:2,height:startY-endY)
            return menuFrame.insetBy(dx:1,dy:1).contains(corridor) && !interactive.contains { $0.frame.insetBy(dx:-1,dy:-1).intersects(corridor) }
        }
        guard let x=channels.first else { try limited(app,"No actual menu padding channel clear of controls; no swipe") }
        result["menuFrameBefore"]=rect(menuFrame);result["timingBefore"]=beforeTiming.map { ["label":$0.label,"frame":rect($0.frame),"fullyInsideMenu":menuFrame.contains($0.frame)] as [String:Any] }
        result["nativeScrollStart"]=["x":x,"y":startY];result["nativeScrollEnd"]=["x":x,"y":endY]
        guard actions["menuInternalScroll",default:0]==0 else { try limited(app,"Internal scroll already consumed") }
        try guardUI(app);actions["menuInternalScroll",default:0]+=1
        let origin=app.coordinate(withNormalizedOffset:CGVector(dx:0,dy:0))
        origin.withOffset(CGVector(dx:x,dy:startY)).press(forDuration:0.05,thenDragTo:origin.withOffset(CGVector(dx:x,dy:endY)))
        guard let afterTree=evidence(app,"menu-scroll-03-after-single-scroll") else { try limited(app,"Post-scroll original image/AX unavailable; no repeat gesture") }
        let (afterMenu,afterNodes)=try menuScrollTree(app,afterTree,"after")
        let afterTiming=afterNodes.filter { timingLabels.contains($0.label) && $0.elementType == .menuItem }
        let afterTitle=afterNodes.filter { $0.label=="字幕时间" && $0.elementType == .staticText }
        guard afterTiming.count==2,Set(afterTiming.map(\.label))==Set(timingLabels),afterTitle.count==1 else {
            try limited(app,"Post-scroll actual timing identity unavailable")
        }
        let sameMenu=abs(menuFrame.minX-afterMenu.minX)<=1 && abs(menuFrame.minY-afterMenu.minY)<=1 && abs(menuFrame.width-afterMenu.width)<=1 && abs(menuFrame.height-afterMenu.height)<=1
        let rowMoved=beforeTitle[0].frame.minY-afterTitle[0].frame.minY>1
        var timingFull=afterMenu.contains(afterTitle[0].frame)
        var timingHit=true
        var timingActual:[[String:Any]]=[]
        for n in afterTiming {
            timingFull = timingFull && afterMenu.contains(n.frame) && n.frame.width>=44 && n.frame.height>=44
            // Read-only exact observed timing MenuItems. Do not expand A9's action whitelist.
            let query=app.descendants(matching:.menuItem).matching(NSPredicate(format:"label == %@",n.label))
            let count=query.count
            let actual=query.element
            let actualFrame=count==1 ? actual.frame : CGRect.null
            let sameFrame=count==1 && actualFrame==n.frame
            let hittable=count==1 && actual.exists && actual.isHittable
            timingActual.append(["label":n.label,"type":XCUIElement.ElementType.menuItem.rawValue,"count":count,
                                 "actualFrame":a9Frame(actualFrame),"matchesOwnedMenuSnapshot":sameFrame,"isHittable":hittable])
            timingHit = timingHit && sameFrame && hittable
        }
        result["timingActualReadOnlyControls"]=timingActual
        result["menuFrameAfter"]=rect(afterMenu);result["menuFrameStable"]=sameMenu;result["timingRowMovedWithinMenu"]=rowMoved
        result["timingAfter"]=afterTiming.map { ["label":$0.label,"frame":rect($0.frame),"fullyInsideMenu":afterMenu.contains($0.frame)] as [String:Any] }
        result["bottomTimingTargetsFullyVisible44"]=timingFull;result["bottomTimingTargetsHittable"]=timingHit
        let closers=afterNodes.filter { $0.label=="关闭字幕菜单" && ($0.elementType == .button || $0.elementType == .other || $0.elementType == .menuItem) }
        guard closers.count==1,a9Positive(closers[0].frame) else { try limited(app,"Observed close target no longer unique; no fallback or reverse scroll") }
        let closeNode=closers[0]
        let close=try a9ExactSemanticControl(app,label:closeNode.label,type:closeNode.elementType)
        let closeExists=close.exists
        let actualCloseFrame=closeExists ? close.frame : CGRect.null
        let closeHittable=closeExists && close.isHittable
        let sameCloseFrame=closeExists && actualCloseFrame==closeNode.frame && close.frame==actualCloseFrame
        let intersection=actualCloseFrame.intersection(afterMenu)
        let fullClose=sameCloseFrame && afterMenu.contains(actualCloseFrame) && actualCloseFrame.width>=44 && actualCloseFrame.height>=44
        result["closeSnapshotFrameAfterScroll"]=rect(closeNode.frame);result["closeActualFrameAfterScroll"]=a9Frame(actualCloseFrame)
        result["closeActualFrameMatchesOwnedMenuSnapshot"]=sameCloseFrame;result["closeIsHittable"]=closeHittable
        result["closeVisibleIntersection"]=a9Frame(intersection);result["closeTargetFullyVisible44"]=fullClose
        let center=CGPoint(x:actualCloseFrame.midX,y:actualCloseFrame.midY)
        let safeClose=sameCloseFrame && closeHittable && a9Positive(actualCloseFrame) && a9Positive(intersection) && intersection.insetBy(dx:2,dy:2).contains(center)
        result["closeCenterSafelyReachable"]=safeClose
        if !safeClose {
            result["outcome"]="OBSERVED_CLOSE_SCROLL_REACHABILITY_GAP_NO_UNSAFE_CLOSE"
            json(result,"menu-scroll-observed-gap")
            XCTFail("After one owned menu scroll the original close target has no safely visible center; original App restoration is external cleanup")
            return
        }
        try guardUI(app);tap(close,"FRMenuClose")
        let closed=closePresence.waitForNonExistence(timeout:3);result["closeObserved"]=closed
        guard let finalTree=evidence(app,"menu-scroll-04-closed-focus-review") else { try limited(app,"Final focus-review original image/AX unavailable") }
        guard menuScrollOwnedTabIDs(finalTree)==["87246FAF-A680-4738-BA2A-97A9E170620D"] else { try limited(app,"Final retained tab ownership changed") }
        let finalScene=try a9Scene(app,finalTree,"scroll-final",Date())
        result["entryReturnedUnique"]=finalScene.entryCount==1 && finalScene.entryLabel==scene.entryLabel
        result["outcome"]="UI_ACTIONS_RECORDED_REQUIRES_ORIGINAL_PIXEL_AND_FOCUS_REVIEW"
        json(result,"menu-scroll-outcome-before-assertions")
        // Raw failures remain failures. A safe partial Close tap never becomes a complete44px target claim.
        XCTAssertTrue(sameMenu,"Menu movement is not proven internal scrolling")
        XCTAssertTrue(rowMoved,"Single native gesture did not move the actual timing row")
        XCTAssertTrue(timingFull && timingHit,"Bottom timing row/actual44px targets remain clipped or unreachable")
        XCTAssertTrue(fullClose,"Close target is partly scrolled outside the menu; do not accept partial44px geometry")
        XCTAssertTrue(closed && finalScene.closeCount==0,"Normal close did not remove the current owned menu")
        XCTAssertTrue(finalScene.entryCount==1 && finalScene.entryLabel==scene.entryLabel,"Normal close did not restore the same unique entry")
    }

    func test114ProductionMenuItemClose() throws {
        let app=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari")
        try navigate(app)
        let scene=try a9PrepareMenuScene(app)
        try a9PlayingMenu(app,scene:scene)
        // No CC/Play operations or second reveal: missing current captions cannot erase the secured menu evidence.
        _=try waitForRealBilingual(app,"A9-real-bilingual-after-menu")
        json(["outcome":"A9_MENU_BILINGUAL_AND_PLAYING_SAME_SCENE_REQUIRE_SEPARATE_REVIEW","actions":actions,
              "maxEntireCaseCenterTouches":1,"CCOrPlayActedByA9":false,"noPauseNoForcedControls":true],"outcome")
    }
    func nativeButton(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.buttons[id] }
    func revealNativeOnce(_ app: XCUIApplication, _ key: String) -> Bool {
        let media=app.otherElements["媒体"]
        guard actions[key,default:0]==0,media.exists,!media.frame.isEmpty,app.frame.contains(media.frame),app.alerts.count==0 else { return false }
        actions[key,default:0]+=1;media.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)).tap();return true
    }
    func nativeCaptions(_ app: XCUIApplication, _ prefix: String) throws -> XCUIElement {
        try guardUI(app);let more=nativeButton(app,"Overflow Menu")
        if !more.exists || !more.isHittable { _=revealNativeOnce(app,"nativeControlsReveal") }
        guard ready(more) else { try limited(app,"Actual AVKit overflow unavailable") };tap(more,prefix+"-overflow")
        let captions=app.buttons["字幕"];guard ready(captions) else { try limited(app,"Actual AVKit captions submenu unavailable") };tap(captions,prefix+"-captions")
        evidence(app,prefix+"-actual-track-menu")
        return app.buttons["FluentRead"]
    }
    func returnInlineIfKnown(_ app: XCUIApplication, _ kind: String) -> Bool {
        guard app.alerts.count==0 else { return false }
        if kind=="AVKit" {
            guard actions["nativeReturn",default:0]==0 else { return false }
            let close=app.buttons["Close Button"]
            if !close.exists || !close.isHittable { _=revealNativeOnce(app,"nativeReturnControlsReveal") }
            guard close.exists&&close.isHittable else { return false };tap(close,"nativeReturn")
            return app.otherElements["媒体"].waitForNonExistence(timeout:5)&&candidate(app).exists
        }
        if kind=="HTML" {
            guard actions["HTMLReturn",default:0]==0 else { return false }
            let close=app.webViews.buttons["退出全屏模式"]
            if !close.exists || !close.isHittable {
                let p=player(app)
                if actions["HTMLReturnControlsReveal",default:0]==0,p.exists,p.isHittable,!p.frame.isEmpty,app.frame.contains(p.frame) {
                    actions["HTMLReturnControlsReveal",default:0]+=1;p.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)).tap()
                }
            }
            guard close.exists&&close.isHittable else { return false };tap(close,"HTMLReturn")
            return close.waitForNonExistence(timeout:5)&&candidate(app).exists
        }
        return false
    }
    func test109ProductionIndependentFullscreenTrackAndCues() throws {
        let app=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari");var kind="unestablished";var returned=false
        defer { if !returned&&kind != "unestablished" { returned=returnInlineIfKnown(app,kind) };json(["kind":kind,"normalInlineReturn":returned,"actions":actions,"preciseAudioPlaybackRestored":false],"B-finally-return") }
        try navigate(app);try prepareCCAndPlayback(app)
        let enter=app.webViews.buttons["进入全屏模式"]
        if !enter.exists || !enter.isHittable { try showControlsOnce(app,"fullscreenEntryControlReveal") }
        guard ready(enter) else { try limited(app,"Real site fullscreen entry unavailable") };tap(enter,"enterFullscreen")
        let settled=XCTNSPredicateExpectation(predicate:NSPredicate { _,_ in app.otherElements["媒体"].exists || app.webViews.buttons["退出全屏模式"].exists },object:nil)
        _=XCTWaiter.wait(for:[settled],timeout:8)
        if app.otherElements["媒体"].exists { kind="AVKit" }
        else if app.webViews.buttons["退出全屏模式"].exists { kind="HTML" }
        else { try limited(app,"Fullscreen kind not established by actual native media or HTML exit UI") }
        evidence(app,"B-actual-fullscreen-entry");json(["kind":kind,"inlinePauseRequired":false,"inlineFRMenuRequired":false],"B-fullscreen-kind")
        if kind=="AVKit" {
            let play=app.buttons["Play/Pause"]
            if !play.exists || !play.isHittable { _=revealNativeOnce(app,"nativeControlsReveal") }
            if play.exists&&play.isHittable&&["播放","Play"].contains(play.label) { tap(play,"nativePlay") }
            let track=try nativeCaptions(app,"B-track")
            // Track may appear after intro/source hydration; bounded wait is native-menu observation only.
            guard track.exists || track.waitForExistence(timeout:40) else { try limited(app,"Real FluentRead AVKit track unavailable within40s") }
            let before=track.isSelected
            if !before { guard track.isHittable else { try limited(app,"FluentRead native track not hittable") };tap(track,"selectFluentReadTrack") }
            var selected=before
            if track.exists { selected=track.isSelected }
            if !before && !selected { selected=(try nativeCaptions(app,"B-track-verify")).isSelected }
            json(["trackExists":true,"selectedBefore":before,"selectedAfterObserved":selected],"B-FluentRead-track-state")
            let header=app.buttons["字幕"];if header.exists&&header.isHittable { tap(header,"nativeCaptionsReturn") }
            // A normal media touch dismisses remaining native controls; it does not select another track.
            _=revealNativeOnce(app,"nativeMenuDismiss")
            // AVKit caption pixels are not guaranteed to appear in AX. Preserve three actual screens over <=40s;
            // underlying WebView captions are never counted as proof of native rendering.
            let observationStart=Date()
            for seconds in [4.0,16.0,32.0] {
                let remaining=seconds-Date().timeIntervalSince(observationStart);if remaining>0 { wait(remaining) }
                try guardUI(app);evidence(app,"B-native-cue-pixels-"+String(Int(seconds))+"s")
            }
            json(["nativeCueRendering":"MANUAL_PIXEL_REVIEW_REQUIRED","underlyingWebCaptionIsNativeProof":false,"selectedTrackObserved":selected],"B-native-cue-boundary")
        } else {
            _=try waitForRealBilingual(app,"B-HTML-real-bilingual")
            json(["HTMLBilingualAXCaptured":true,"AVKitTrackExercised":false],"B-HTML-boundary")
        }
        returned=returnInlineIfKnown(app,kind);evidence(app,"B-normal-inline-return")
        json(["outcome":"FULLSCREEN_ACTIONS_RECORDED_REQUIRES_NATIVE_PIXEL_OR_HTML_CUE_REVIEW","kind":kind,"normalInlineReturn":returned,"actions":actions,"rotationBackgroundModeMatrix":false],"outcome")
    }
}
