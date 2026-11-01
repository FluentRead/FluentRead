// 容器应用的界面脚本：把 Safari 报告的扩展状态映射到页面状态与状态徽标。
function setStatus(text, state) {
    const badge = document.getElementById('status');
    if (badge) {
        badge.textContent = text;
        badge.dataset.state = state;
    }
}

function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText =
            '扩展已启用。可在 Safari 设置的“扩展”分区中调整。';
        document.getElementsByClassName('state-off')[0].innerText =
            '扩展尚未启用。请在 Safari 设置的“扩展”分区中勾选“流畅阅读”。';
        document.getElementsByClassName('state-unknown')[0].innerText =
            '正在读取 Safari 扩展状态…';
        document.getElementsByClassName('open-preferences')[0].innerText =
            '退出并打开 Safari 设置';
    }

    if (typeof enabled === 'boolean') {
        document.body.classList.toggle('state-on', enabled);
        document.body.classList.toggle('state-off', !enabled);
        setStatus(enabled ? '已启用' : '未启用', enabled ? 'on' : 'off');
    } else {
        document.body.classList.remove('state-on');
        document.body.classList.remove('state-off');
        const unknown = document.getElementsByClassName('state-unknown')[0];
        if (unknown) unknown.innerText = '未检测到扩展状态。请按下面三步在 Safari 中启用“流畅阅读”。';
        setStatus('状态未知', 'unknown');
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage('open-preferences');
}

document.querySelector('button.open-preferences').addEventListener('click', openPreferences);
