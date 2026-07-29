/**
 * 팀 채널 암호화 모듈.
 *
 * 팀 이름 + 팀 암호에서 PBKDF2-SHA256으로 512비트를 유도해
 *   앞 256비트 -> AES-GCM 키 (위치 암호화)
 *   뒤 256비트 -> MQTT 토픽 이름 (채널 식별)
 * 로 나눠 쓴다.
 *
 * 이렇게 하면 팀 암호를 모르는 사람은
 *   1) 어떤 토픽을 구독해야 하는지 알 수 없고
 *   2) 우연히 토픽을 알아내도 페이로드를 복호화할 수 없다.
 *
 * window.RtlocCrypto 로 노출되며, 앱과 자체 점검 페이지가 같은 코드를 사용한다.
 */
(function (global) {
  "use strict";

  var TOPIC_PREFIX = "rtloc/v2";
  var PBKDF2_ITERATIONS = 200000;
  var ENVELOPE_VERSION = 2;

  function assertAvailable() {
    if (!global.crypto || !global.crypto.subtle) {
      throw new Error("이 환경에서는 웹 암호화(Web Crypto)를 사용할 수 없습니다. HTTPS로 접속해 주세요.");
    }
  }

  function normalizeTeam(name) {
    return String(name).trim().replace(/\s+/g, " ");
  }

  /**
   * @returns {Promise<{key: CryptoKey, topic: string, topicId: string}>}
   */
  function deriveTeam(teamName, secret) {
    assertAvailable();

    var enc = new TextEncoder();
    var team = normalizeTeam(teamName).toLocaleLowerCase("ko");
    var salt = enc.encode(TOPIC_PREFIX + "|team|" + team);

    return crypto.subtle
      .importKey("raw", enc.encode(String(secret)), "PBKDF2", false, ["deriveBits"])
      .then(function (baseKey) {
        return crypto.subtle.deriveBits(
          { name: "PBKDF2", salt: salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          baseKey,
          512
        );
      })
      .then(function (bits) {
        var bytes = new Uint8Array(bits);
        var topicId = toHex(bytes.subarray(32, 64)).slice(0, 32);

        return crypto.subtle
          .importKey("raw", bytes.subarray(0, 32), { name: "AES-GCM" }, false, [
            "encrypt",
            "decrypt"
          ])
          .then(function (key) {
            return { key: key, topicId: topicId, topic: TOPIC_PREFIX + "/" + topicId };
          });
      });
  }

  /** 객체를 암호화해 전송용 문자열(JSON 봉투)로 만든다. */
  function encrypt(key, obj) {
    assertAvailable();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = new TextEncoder().encode(JSON.stringify(obj));

    return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, data).then(function (ct) {
      return JSON.stringify({
        v: ENVELOPE_VERSION,
        iv: toBase64(iv),
        ct: toBase64(new Uint8Array(ct))
      });
    });
  }

  /** 봉투 문자열을 복호화한다. 키가 다르면 reject 된다. */
  function decrypt(key, text) {
    assertAvailable();

    var envelope;
    try {
      envelope = JSON.parse(text);
    } catch (e) {
      return Promise.reject(new Error("봉투 형식이 아닙니다."));
    }
    if (!envelope || envelope.v !== ENVELOPE_VERSION || !envelope.iv || !envelope.ct) {
      return Promise.reject(new Error("지원하지 않는 봉투 버전입니다."));
    }

    return crypto.subtle
      .decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.ct))
      .then(function (plain) {
        return JSON.parse(new TextDecoder().decode(plain));
      });
  }

  function toHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  function toBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  global.RtlocCrypto = {
    TOPIC_PREFIX: TOPIC_PREFIX,
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    normalizeTeam: normalizeTeam,
    deriveTeam: deriveTeam,
    encrypt: encrypt,
    decrypt: decrypt
  };
})(window);
