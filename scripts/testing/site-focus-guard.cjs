'use strict';

// The caller binds only its guarded browser; event timestamps describe observation,
// not the cause of an activation. No application is activated or restored here.
function createSiteFocusGuard(startMonitor) {
  let monitor, browserPid, browser, closePromise, failure, phase = 'observer-start';
  const phases = [], events = [];
  let observerReady = null, observerStopped = false;
  const mark = name => {phase = name; phases.push({phase: name, time: Date.now()});};
  const requestClose = () => {
    if (browser && !closePromise) {
      closePromise = Promise.resolve().then(() => browser.close());
      void closePromise.catch(() => {});
    }
    return closePromise;
  };
  const fail = error => {
    failure ||= error?.code === 'FOCUS_SAFETY_VIOLATION' ? error
      : Object.assign(new Error(`焦点监控不可用：${error?.message || error}`, {cause: error}), {code: 'FOCUS_SAFETY_VIOLATION'});
    requestClose();
  };
  const check = () => {
    if (monitor?.error) fail(monitor.error);
    if (failure) throw failure;
  };
  async function start() {
    try {
      monitor = startMonitor({onEvent: event => {
        events.push({...event, observedPhase: phase, receivedAt: Date.now()});
        if (browserPid && event.pid === browserPid) fail(Object.assign(new Error(`Owned Edge ${browserPid} activation observed`), {code: 'FOCUS_SAFETY_VIOLATION'}));
      }, onError: fail});
      observerReady = await monitor.ready;
      check();
    } catch (error) {fail(error); throw failure;}
  }
  function register(guardedBrowser) {
    browser = guardedBrowser;
    if (failure) requestClose();
    check();
  }
  function bind(ownedBrowser, pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      fail(new Error('无法确认受控浏览器 PID')); throw failure;
    }
    browser = ownedBrowser; browserPid = pid;
    if (events.some(event => event.pid === pid)) fail(Object.assign(new Error(`Owned Edge ${pid} activation observed before identity was confirmed`), {code: 'FOCUS_SAFETY_VIOLATION'}));
    if (failure) requestClose();
    check();
  }
  async function stop() {
    if (!monitor) return;
    try {await monitor.stop(); observerStopped = true;} catch (error) {fail(error);}
    check();
  }
  return {start, register, bind, mark, check, stop, requestClose, fail,
    get failure() {return failure;},
    snapshot: () => ({status: failure ? 'failed' : observerReady && browserPid && observerStopped ? 'complete' : 'unknown',
      browserPid: browserPid ?? null, observerReady, observerStopped, phases: [...phases], events: [...events],
      error: failure ? String(failure.message || failure) : null})};
}

module.exports = {createSiteFocusGuard};
