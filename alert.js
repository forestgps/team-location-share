/**
 * 메시지 도착 알림(진동 + 경고음).
 *
 * 소리는 파일을 쓰지 않고 WebAudio 로 즉석에서 만든다. 내려받을 자원이 없어야
 * 통신이 나쁜 현장에서도 확실히 울린다.
 *
 * 브라우저 제약
 *  - 소리는 사용자가 한 번 화면을 터치한 뒤에만 재생할 수 있다. 그래서 입장 버튼을
 *    누르는 시점에 오디오를 미리 준비(unlock)해 둔다.
 *  - 진동은 안드로이드 크롬/WebView 에서만 동작한다. iOS 사파리는 지원하지 않는다.
 *
 * window.RtlocAlert 로 노출된다.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "rtloc.alert.enabled";

  var audioContext = null;
  var unlocked = false;

  /** 저장된 설정. 기본값은 켜짐. */
  function isEnabled() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "off";
    } catch (e) {
      return true;
    }
  }

  function setEnabled(on) {
    try {
      localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch (e) {
      /* 프라이빗 모드 등 */
    }
    return on;
  }

  /** 사용자 조작 시점에 호출한다. 이후 소리를 낼 수 있게 된다. */
  function unlock() {
    if (unlocked) return true;

    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return false;

    try {
      audioContext = audioContext || new Ctor();
      if (audioContext.state === "suspended") audioContext.resume();
      unlocked = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 짧은 경고음 두 번. */
  function beep() {
    if (!audioContext) return false;
    if (audioContext.state === "suspended") audioContext.resume();

    var now = audioContext.currentTime;

    // 두 번 울린다. 주변 소음에서도 알아채도록 서로 다른 음높이를 쓴다.
    [
      { at: 0, freq: 988, length: 0.18 },
      { at: 0.24, freq: 1319, length: 0.22 }
    ].forEach(function (tone) {
      var osc = audioContext.createOscillator();
      var gain = audioContext.createGain();

      osc.type = "square";
      osc.frequency.value = tone.freq;

      // 딸깍 소리가 나지 않게 볼륨을 부드럽게 올리고 내린다.
      gain.gain.setValueAtTime(0.0001, now + tone.at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + tone.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.length);

      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(now + tone.at);
      osc.stop(now + tone.at + tone.length + 0.02);
    });

    return true;
  }

  function vibrate() {
    if (!global.navigator || typeof navigator.vibrate !== "function") return false;
    try {
      // 짧게-길게 패턴. 위치 알림과 구분되도록 두 박자로 준다.
      return navigator.vibrate([220, 120, 320]);
    } catch (e) {
      return false;
    }
  }

  /**
   * 메시지 도착 알림을 울린다.
   * @returns {{enabled: boolean, vibrated: boolean, played: boolean}}
   */
  function notifyMessage() {
    if (!isEnabled()) {
      return { enabled: false, vibrated: false, played: false };
    }
    return { enabled: true, vibrated: vibrate(), played: beep() };
  }

  /**
   * 브라우저 알림 권한을 미리 받아 둔다.
   * 화면을 보고 있지 않을 때 시스템 팝업을 띄우려면 필요하다.
   */
  function requestSystemPermission() {
    if (!global.Notification || Notification.permission !== "default") return;
    try {
      Notification.requestPermission();
    } catch (e) {
      /* 구형 브라우저 */
    }
  }

  /**
   * 화면을 보고 있지 않을 때 시스템 팝업을 띄운다.
   * 안드로이드 앱에서는 네이티브 서비스가 대신 처리하므로 호출하지 않는다.
   * @returns {boolean} 띄웠는지
   */
  function showSystemNotification(title, body) {
    if (!isEnabled()) return false;
    if (!global.Notification || Notification.permission !== "granted") return false;
    if (document.visibilityState === "visible") return false;

    try {
      var notification = new Notification(title, {
        body: body,
        tag: "rtloc-message",
        renotify: true,
        vibrate: [220, 120, 320]
      });
      notification.onclick = function () {
        global.focus();
        notification.close();
      };
      return true;
    } catch (e) {
      return false;
    }
  }

  global.RtlocAlert = {
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    unlock: unlock,
    beep: beep,
    vibrate: vibrate,
    notifyMessage: notifyMessage,
    requestSystemPermission: requestSystemPermission,
    showSystemNotification: showSystemNotification
  };
})(window);
