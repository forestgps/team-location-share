/**
 * 팀 메시지 저장소.
 *
 * 메시지는 위치와 같은 암호화 채널로 오간다. 서버에 남지 않으므로 접속 중인 대원만
 * 실시간으로 받고, 각자 기기에 최근 기록만 보관한다.
 *
 * 팀별로 분리해서 저장하며(토픽 기준), 최근 200건만 남긴다.
 *
 * window.RtlocChat 으로 노출된다.
 */
(function (global) {
  "use strict";

  var STORAGE_PREFIX = "rtloc.chat.";
  var MAX_MESSAGES = 200;
  var MAX_TEXT_LENGTH = 500;

  function storageKey(teamKey) {
    return STORAGE_PREFIX + teamKey;
  }

  function list(teamKey) {
    var raw;
    try {
      raw = localStorage.getItem(storageKey(teamKey));
    } catch (e) {
      return [];
    }
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 메시지를 저장한다. 같은 id 가 이미 있으면 무시한다(중복 수신 방지).
   * @returns {boolean} 새로 저장했는지
   */
  function append(teamKey, message) {
    var messages = list(teamKey);

    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id === message.id) return false;
    }

    messages.push(message);
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(messages.length - MAX_MESSAGES);
    }

    try {
      localStorage.setItem(storageKey(teamKey), JSON.stringify(messages));
    } catch (e) {
      // 용량이 부족하면 절반을 버리고 다시 시도한다.
      try {
        messages = messages.slice(Math.floor(messages.length / 2));
        localStorage.setItem(storageKey(teamKey), JSON.stringify(messages));
      } catch (e2) {
        return true; // 저장은 실패했지만 화면에는 띄운다
      }
    }
    return true;
  }

  function clear(teamKey) {
    try {
      localStorage.removeItem(storageKey(teamKey));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 전송 가능한 형태로 정리한다. 빈 메시지면 null. */
  function build(text, senderId, senderName) {
    var trimmed = String(text == null ? "" : text).trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_TEXT_LENGTH) trimmed = trimmed.slice(0, MAX_TEXT_LENGTH);

    return {
      id: newId(),
      text: trimmed,
      senderId: senderId,
      senderName: senderName,
      ts: Date.now()
    };
  }

  /** 수신 메시지 검증. 형식이 어긋나면 null. */
  function sanitize(wire) {
    if (!wire || typeof wire.text !== "string" || !wire.id) return null;
    var text = wire.text.trim();
    if (!text) return null;

    return {
      id: String(wire.id),
      text: text.slice(0, MAX_TEXT_LENGTH),
      senderId: String(wire.senderId || ""),
      senderName: String(wire.senderName || "대원"),
      ts: typeof wire.ts === "number" ? wire.ts : Date.now()
    };
  }

  function newId() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  global.RtlocChat = {
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
    MAX_MESSAGES: MAX_MESSAGES,
    list: list,
    append: append,
    clear: clear,
    build: build,
    sanitize: sanitize,
    newId: newId
  };
})(window);
