/**
 * 팀 실시간 위치 공유 (종단간 암호화)
 *
 * 보안 모델
 *  - 팀 이름 + 팀 암호에서 PBKDF2-SHA256(200,000회)로 512비트를 유도한다.
 *      앞 256비트 -> AES-GCM 암호화 키
 *      뒤 256비트 -> MQTT 토픽 이름 (해시 형태)
 *  - 위치는 AES-GCM으로 암호화해서 발행한다. 브로커와 제3자는 내용을 볼 수 없다.
 *  - 토픽 이름 자체가 암호에서 유도되므로, 암호를 모르면 팀 채널의 존재도 알 수 없다.
 *  - 팀 이름이나 암호가 다르면 토픽이 달라 메시지가 아예 전달되지 않고,
 *    설령 토픽이 같아도 키가 달라 복호화에 실패해 무시된다.
 *  - 팀 이름과 암호는 평문으로 네트워크에 나가지 않는다.
 *
 * 한계
 *  - 같은 팀 암호를 가진 사람끼리는 서로를 신뢰한다고 가정한다(팀 내 스푸핑 방지는 없음).
 *  - 암호가 유출되면 팀 전체를 새 암호로 교체해야 한다.
 */
(function () {
  "use strict";

  var PUBLISH_MIN_INTERVAL = 2000;
  var HEARTBEAT_INTERVAL = 10000;
  var STALE_AFTER = 45000;
  var DROP_AFTER = 150000;
  var STORAGE_KEY = "rtloc.profile.v2";
  // 파일 선택 중 앱이 다시 시작되면 되살릴 메모 초안(세션 한정)
  var MEMO_DRAFT_KEY = "rtloc.memoDraft.v1";
  var MAPTYPE_KEY = "rtloc.mapType.v1";

  // 브로커 보관함(retained 메시지)에 올린 첨부 목록. 켤 때마다 다시 올리지 않기 위함이다.
  var VAULT_KEY = "rtloc.vault.v1";
  // 보관함에 올릴 최대 크기. 이보다 크면 접속 중인 대원끼리만 주고받는다.
  // 공개 브로커는 남의 자원이라 보수적으로, 자체 브로커는 팀이 용량을 정하므로 넉넉하게.
  var VAULT_MAX_BYTES = 6 * 1024 * 1024;
  var PRIVATE_VAULT_MAX_BYTES = 64 * 1024 * 1024;
  // 보관함에서 첫 조각을 이 시간 안에 못 받으면 접속 중인 대원에게 요청한다.
  var VAULT_WAIT = 5000;
  // 열어 보기 전에 미리 받아 둘 사진의 최대 크기와, 연달아 받을 때의 간격
  var AUTO_FETCH_MAX = 1.5 * 1024 * 1024;
  var AUTO_FETCH_GAP = 2500;

  // 대원 구분용 색상 팔레트와 중복 없는 배분 규칙은 palette.js 에 있다.
  var PALETTE = RtlocPalette.PALETTE;

  // 기본 브로커 목록. 위에서부터 순서대로 시도한다.
  var DEFAULT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/mqtt"
  ];

  var state = {
    clientId: makeId(),
    teamName: "",
    topic: "",
    cryptoKey: null,
    callsign: "",
    brokers: [],
    brokerIndex: 0,
    client: null,
    map: null,
    follow: true,
    lastPosition: null,
    lastPublishedAt: 0,
    willPayload: null,
    secret: null, // 네이티브 백그라운드 서비스에 넘길 팀 암호 (메모리에만)
    watchId: null,
    heartbeatTimer: null,
    sweepTimer: null,
    wakeLock: null,
    members: Object.create(null),
    recorder: null, // 임무 진행 중일 때만 존재
    clockTimer: null,
    pendingMission: null, // 저장 창에 올라와 있는 임무
    videoRendering: false, // 경로 영상을 녹화하는 중인지
    manualSaveUrl: null, // 수동 저장 링크에 걸어 둔 임시 URL
    historyLayer: null, // 과거 임무를 지도에 겹쳐 볼 때 쓰는 레이어
    memos: Object.create(null), // id -> { memo, marker }
    memoMode: false, // 핀 찍기 대기 상태
    memoDraft: null, // 작성 중인 메모
    memoObjectUrls: [], // 미리보기용 Blob URL (정리 대상)
    memoDetailId: null, // 현재 열려 있는 메모
    mediaRequested: Object.create(null), // 이미 요청한 첨부 (중복 요청 방지)
    mediaSending: Object.create(null), // 내가 보내는 중인 첨부
    chunkSeen: Object.create(null), // 다른 대원이 보내는 중인 첨부 (mediaId -> 시각)
    mediaOwnerMemo: Object.create(null), // mediaId -> memoId
    brokerUser: "", // 자체 브로커 아이디 (없으면 빈 값)
    brokerPass: "",
    vaultMaxBytes: VAULT_MAX_BYTES,
    vaultSubs: Object.create(null), // 보관함을 구독 중인 첨부 (mediaId -> true)
    vaultStashing: Object.create(null), // 보관함에 올리는 중인 첨부
    mediaFromVault: Object.create(null), // 보관함에서 받은 첨부 (재업로드 방지)
    autoFetchQueue: [], // 미리 받아 둘 사진 대기열
    autoFetchTimer: null,
    assembler: null, // 수신 조각 조립기
    unreadCount: 0 // 읽지 않은 메시지 수
  };

  var el = {
    joinScreen: document.getElementById("join-screen"),
    joinForm: document.getElementById("join-form"),
    joinBtn: document.getElementById("join-btn"),
    team: document.getElementById("team"),
    secret: document.getElementById("secret"),
    toggleSecret: document.getElementById("toggle-secret"),
    callsign: document.getElementById("callsign"),
    remember: document.getElementById("remember"),
    broker: document.getElementById("broker"),
    brokerUser: document.getElementById("broker-user"),
    brokerPass: document.getElementById("broker-pass"),
    formError: document.getElementById("form-error"),
    mapScreen: document.getElementById("map-screen"),
    teamBadge: document.getElementById("team-badge"),
    meLabel: document.getElementById("me-label"),
    connStatus: document.getElementById("conn-status"),
    followBtn: document.getElementById("follow-btn"),
    leaveBtn: document.getElementById("leave-btn"),
    missionStartBtn: document.getElementById("mission-start-btn"),
    missionEndBtn: document.getElementById("mission-end-btn"),
    missionClock: document.getElementById("mission-clock"),
    bgBtn: document.getElementById("bg-btn"),
    updateBtn: document.getElementById("update-btn"),
    historyBtn: document.getElementById("history-btn"),
    chatBtn: document.getElementById("chat-btn"),
    chatUnread: document.getElementById("chat-unread"),
    alertBtn: document.getElementById("alert-btn"),
    chatModal: document.getElementById("chat-modal"),
    chatList: document.getElementById("chat-list"),
    chatEmpty: document.getElementById("chat-empty"),
    chatForm: document.getElementById("chat-form"),
    chatInput: document.getElementById("chat-input"),
    chatSend: document.getElementById("chat-send"),
    chatClear: document.getElementById("chat-clear"),
    chatClose: document.getElementById("chat-close"),
    saveModal: document.getElementById("save-modal"),
    missionNameInput: document.getElementById("mission-name"),
    saveSummary: document.getElementById("save-summary"),
    saveVideo: document.getElementById("save-video"),
    saveConfirm: document.getElementById("save-confirm"),
    saveDiscard: document.getElementById("save-discard"),
    saveVideoHelp: document.getElementById("save-video-help"),
    saveVideoSeconds: document.getElementById("save-video-seconds"),
    saveVideoProgress: document.getElementById("save-video-progress"),
    saveVideoFill: document.getElementById("save-video-fill"),
    saveVideoStatus: document.getElementById("save-video-status"),
    saveVideoError: document.getElementById("save-video-error"),
    saveVideoManual: document.getElementById("save-video-manual"),
    saveVideoLink: document.getElementById("save-video-link"),
    historyModal: document.getElementById("history-modal"),
    historyList: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    historyClose: document.getElementById("history-close"),
    memoBtn: document.getElementById("memo-btn"),
    memoListBtn: document.getElementById("memo-list-btn"),
    memoCount: document.getElementById("memo-count"),
    memoHint: document.getElementById("memo-hint"),
    memoModal: document.getElementById("memo-modal"),
    memoCoords: document.getElementById("memo-coords"),
    memoText: document.getElementById("memo-text"),
    memoPhotoBtn: document.getElementById("memo-photo-btn"),
    memoVideoBtn: document.getElementById("memo-video-btn"),
    memoPhotoInput: document.getElementById("memo-photo-input"),
    memoVideoInput: document.getElementById("memo-video-input"),
    memoAttachments: document.getElementById("memo-attachments"),
    memoSave: document.getElementById("memo-save"),
    memoHere: document.getElementById("memo-here"),
    memoCancel: document.getElementById("memo-cancel"),
    memoDetailModal: document.getElementById("memo-detail-modal"),
    memoDetailCoords: document.getElementById("memo-detail-coords"),
    memoDetailText: document.getElementById("memo-detail-text"),
    memoDetailMedia: document.getElementById("memo-detail-media"),
    memoDetailNote: document.getElementById("memo-detail-note"),
    memoCopy: document.getElementById("memo-copy"),
    memoEdit: document.getElementById("memo-edit"),
    memoDelete: document.getElementById("memo-delete"),
    memoDetailClose: document.getElementById("memo-detail-close"),
    memoListModal: document.getElementById("memo-list-modal"),
    memoList: document.getElementById("memo-list"),
    memoListEmpty: document.getElementById("memo-list-empty"),
    memoListClose: document.getElementById("memo-list-close"),
    memberList: document.getElementById("member-list"),
    memberCount: document.getElementById("member-count"),
    emptyHint: document.getElementById("empty-hint"),
    toast: document.getElementById("toast")
  };

  // ---------- 초기화 ----------
  init();

  function init() {
    registerServiceWorker();
    restoreProfile();
    importBrokerFromUrl();

    el.joinForm.addEventListener("submit", onSubmit);
    el.team.addEventListener("input", clearFormError);
    el.secret.addEventListener("input", clearFormError);

    el.toggleSecret.addEventListener("click", function () {
      var showing = el.secret.type === "text";
      el.secret.type = showing ? "password" : "text";
      el.toggleSecret.textContent = showing ? "보기" : "숨기기";
      el.toggleSecret.setAttribute("aria-pressed", String(!showing));
    });

    // 보안 컨텍스트가 아니면 위치도 암호화도 불가능하다. 미리 알려준다.
    if (!window.isSecureContext) {
      showFormError(
        "이 페이지는 HTTPS(또는 localhost)에서 열어야 합니다. 현재 환경에서는 위치 권한과 암호화를 쓸 수 없습니다."
      );
    } else if (!(window.crypto && crypto.subtle)) {
      showFormError("이 브라우저는 웹 암호화(Web Crypto)를 지원하지 않아 사용할 수 없습니다.");
    }

    // 초기화가 끝났음을 표시한다(디버깅/점검용).
    document.documentElement.setAttribute("data-app-ready", "1");
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {
        // 오프라인 캐시는 부가 기능이므로 실패해도 앱 동작에는 영향이 없다.
      });
    });
  }

  // ---------- 프로필 저장/복원 ----------
  function restoreProfile() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;

    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      return;
    }

    el.team.value = saved.team || "";
    el.secret.value = saved.secret || "";
    el.callsign.value = saved.callsign || "";
    el.broker.value = saved.broker || "";
    el.brokerUser.value = saved.brokerUser || "";
    el.brokerPass.value = saved.brokerPass || "";
    el.remember.checked = true;
  }

  /**
   * 초대 링크에 담긴 브로커 설정을 받아 둔다.
   *
   * 팀장이 자체 브로커를 쓰면 대원마다 주소와 아이디를 입력해야 하는데, 현장에서는
   * 그게 곧 사고다. 링크(또는 QR)에 담아 보내면 한 번만 열어도 기기에 저장된다.
   * 예: ...?b=wss://mqtt.example.com:8084/mqtt&u=team&p=암호
   *
   * 주소창에 암호가 남지 않도록 읽은 뒤 링크를 정리한다.
   */
  function importBrokerFromUrl() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      return;
    }

    var broker = params.get("b");
    var user = params.get("u");
    var pass = params.get("p");
    if (!broker && !user && !pass) return;

    if (broker) el.broker.value = broker;
    if (user) el.brokerUser.value = user;
    if (pass) el.brokerPass.value = pass;

    // 다음에도 쓰도록 이 기기에 저장한다.
    el.remember.checked = true;
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var saved = raw ? JSON.parse(raw) : {};
      saved.broker = el.broker.value.trim();
      saved.brokerUser = el.brokerUser.value.trim();
      saved.brokerPass = el.brokerPass.value;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {
      /* 저장이 막히면 이번 접속에만 적용된다 */
    }

    if (window.history && history.replaceState) {
      history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }

  function saveProfile() {
    try {
      if (el.remember.checked) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            team: state.teamName,
            secret: el.secret.value,
            callsign: state.callsign,
            broker: el.broker.value.trim(),
            brokerUser: el.brokerUser.value.trim(),
            brokerPass: el.brokerPass.value
          })
        );
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      // 프라이빗 모드 등에서 저장이 막힐 수 있다. 무시한다.
    }
  }

  // ---------- 입장 ----------
  function onSubmit(event) {
    event.preventDefault();

    var team = normalizeTeam(el.team.value);
    var secret = el.secret.value;

    if (!team) {
      showFormError("소속팀 이름은 필수입니다.");
      el.team.focus();
      return;
    }
    if (team.length < 2) {
      showFormError("소속팀 이름은 2자 이상으로 입력해 주세요.");
      el.team.focus();
      return;
    }
    if (secret.length < 6) {
      showFormError("팀 암호는 6자 이상이어야 합니다. 팀원 전원이 같은 암호를 써야 합니다.");
      el.secret.focus();
      return;
    }
    if (!("geolocation" in navigator)) {
      showFormError("이 브라우저는 위치 기능(Geolocation)을 지원하지 않습니다.");
      return;
    }
    if (!window.isSecureContext || !(window.crypto && crypto.subtle)) {
      showFormError("HTTPS 환경이 아니거나 웹 암호화를 쓸 수 없어 입장할 수 없습니다.");
      return;
    }
    clearFormError();

    state.teamName = team;
    state.callsign = el.callsign.value.trim() || "대원-" + state.clientId.slice(0, 4);

    var custom = el.broker.value.trim();
    state.brokers = custom ? [custom] : DEFAULT_BROKERS.slice();
    state.brokerIndex = 0;
    state.brokerUser = el.brokerUser.value.trim();
    state.brokerPass = el.brokerPass.value;
    // 자체 브로커는 보관 용량을 팀이 직접 정하므로 큰 파일도 보관한다.
    state.vaultMaxBytes = custom ? PRIVATE_VAULT_MAX_BYTES : VAULT_MAX_BYTES;

    // 소리는 사용자 조작 직후에만 준비할 수 있다. 입장 버튼이 그 시점이다.
    RtlocAlert.unlock();
    // 화면을 보고 있지 않을 때 팝업을 띄우기 위한 알림 권한도 이때 요청한다.
    RtlocAlert.requestSystemPermission();

    el.joinBtn.disabled = true;
    el.joinBtn.textContent = "암호 키 생성 중…";

    RtlocCrypto.deriveTeam(team, secret)
      .then(function (derived) {
        state.cryptoKey = derived.key;
        state.topic = derived.topic;

        saveProfile();
        // 암호는 메모리에서만 쓰고 입력값은 지운다.
        el.secret.value = "";

        // 브라우저가 갑자기 닫혀도 브로커가 퇴장 메시지를 대신 보내도록
        // 암호화된 유언(LWT) 페이로드를 미리 만들어 둔다.
        return encryptMessage({ type: "leave", id: state.clientId });
      })
      .then(function (willPayload) {
        state.willPayload = willPayload;
        // 안드로이드 앱의 백그라운드 추적 서비스에 넘겨줄 값. 메모리에만 둔다.
        state.secret = secret;
        enterMapScreen();
        connect();
        startTracking();
        requestWakeLock();
      })
      .catch(function (err) {
        el.joinBtn.disabled = false;
        el.joinBtn.textContent = "입장하기";
        showFormError("입장에 실패했습니다: " + err.message);
      });
  }

  function showFormError(message) {
    el.formError.textContent = message;
    el.formError.hidden = false;
  }

  function clearFormError() {
    el.formError.hidden = true;
    el.formError.textContent = "";
  }

  function normalizeTeam(value) {
    return RtlocCrypto.normalizeTeam(value);
  }

  // ---------- 암호화 (crypto-team.js 위임) ----------
  function encryptMessage(obj) {
    return RtlocCrypto.encrypt(state.cryptoKey, obj);
  }

  function decryptMessage(text) {
    return RtlocCrypto.decrypt(state.cryptoKey, text);
  }

  // ---------- 화면 ----------
  function enterMapScreen() {
    el.joinScreen.hidden = true;
    el.mapScreen.hidden = false;
    el.teamBadge.textContent = state.teamName;
    el.meLabel.textContent = state.callsign;
    document.title = state.teamName + " · 실시간 위치 공유";
    initMap();
  }

  function initMap() {
    // 지도 스크립트를 못 받아도 나머지 기능은 살려 둔다. 여기서 멈추면 나가기도 못 누른다.
    // 이때 RtlocMap 은 무동작 객체를 돌려주므로 아래 지도 호출은 조용히 흘러간다.
    state.map = RtlocMap.createMap("map", { center: [36.5, 127.9], zoom: 7 });
    if (!RtlocMap.isReady()) showMapLoadError();

    setupMapTypes();

    state.map.on("dragstart", function () {
      if (state.follow) setFollow(false);
    });

    el.followBtn.addEventListener("click", function () {
      setFollow(!state.follow);
      if (state.follow && state.lastPosition) {
        state.map.setView(
          [state.lastPosition.lat, state.lastPosition.lng],
          Math.max(state.map.getZoom(), 16)
        );
      }
    });

    el.leaveBtn.addEventListener("click", leave);
    setupBackgroundTracking();
    setupChat();

    el.missionStartBtn.addEventListener("click", function () {
      startMission(null, true);
    });
    el.missionEndBtn.addEventListener("click", function () {
      endMission(true);
    });
    el.historyBtn.addEventListener("click", openHistory);
    el.historyClose.addEventListener("click", function () {
      el.historyModal.hidden = true;
    });

    el.saveVideo.addEventListener("click", saveWithVideo);
    el.saveConfirm.addEventListener("click", confirmSave);
    el.saveDiscard.addEventListener("click", discardSave);

    // 메모
    el.memoBtn.addEventListener("click", toggleMemoMode);
    el.memoListBtn.addEventListener("click", openMemoList);
    el.memoListClose.addEventListener("click", function () {
      el.memoListModal.hidden = true;
    });
    el.memoSave.addEventListener("click", saveMemoDraft);
    el.memoCancel.addEventListener("click", closeMemoEditor);
    el.memoHere.addEventListener("click", moveDraftToMyPosition);
    // 첨부 버튼은 label 이므로 파일 선택 창은 브라우저가 직접 연다.
    // 자바스크립트가 할 일은 작성 중인 내용을 잃지 않게 남겨 두는 것뿐이다.
    setupNativeAttachReceiver();
    bindFilePickerLabel(el.memoPhotoBtn, el.memoPhotoInput, "image");
    bindFilePickerLabel(el.memoVideoBtn, el.memoVideoInput, "video");
    el.memoPhotoInput.addEventListener("change", onAttachmentPicked);
    el.memoVideoInput.addEventListener("change", onAttachmentPicked);
    el.memoDetailClose.addEventListener("click", closeMemoDetail);

    state.map.on("click", onMapClick);

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!el.chatModal.hidden) el.chatModal.hidden = true;
      else if (!el.historyModal.hidden) el.historyModal.hidden = true;
      else if (!el.memoListModal.hidden) el.memoListModal.hidden = true;
      else if (!el.memoDetailModal.hidden) closeMemoDetail();
      else if (!el.memoModal.hidden) closeMemoEditor();
      else if (state.memoMode) setMemoMode(false);
    });

    loadMemos();
    restorePendingMemoDraft();
  }

  // ---------- 메모: 핀 찍기 ----------
  function toggleMemoMode() {
    setMemoMode(!state.memoMode);
  }

  function setMemoMode(on) {
    state.memoMode = on;
    el.memoBtn.setAttribute("aria-pressed", String(on));
    el.memoBtn.classList.toggle("active", on);
    el.memoBtn.textContent = on ? "메모 위치 지정 중" : "메모";
    el.memoHint.hidden = !on;
    document.getElementById("map").classList.toggle("picking", on);
  }

  /** @param {{lat: number, lng: number}} point 어댑터가 지도 좌표를 숫자로 넘겨준다 */
  function onMapClick(point) {
    if (!state.memoMode) return;
    setMemoMode(false);
    openMemoEditor({
      id: RtlocMemo.newId(),
      teamKey: state.topic,
      lat: point.lat,
      lng: point.lng,
      text: "",
      createdAt: Date.now(),
      author: state.callsign,
      authorId: state.clientId,
      remote: false,
      media: []
    });
  }

  function moveDraftToMyPosition() {
    if (!state.memoDraft) return;
    if (!state.lastPosition) {
      toast("아직 내 위치를 확인하지 못했습니다.");
      return;
    }
    state.memoDraft.lat = state.lastPosition.lat;
    state.memoDraft.lng = state.lastPosition.lng;
    renderCoords(el.memoCoords, state.memoDraft.lat, state.memoDraft.lng);
    toast("메모 위치를 현재 내 위치로 바꿨습니다.");
  }

  // ---------- 메모: 작성 ----------
  function openMemoEditor(memo) {
    state.memoDraft = memo;
    el.memoText.value = memo.text || "";
    renderCoords(el.memoCoords, memo.lat, memo.lng);
    renderDraftAttachments();
    el.memoModal.hidden = false;
    el.memoText.focus();
  }

  function closeMemoEditor() {
    el.memoModal.hidden = true;
    state.memoDraft = null;
    el.memoPhotoInput.value = "";
    el.memoVideoInput.value = "";
    forgetPendingMemoDraft();
  }

  /**
   * 첨부 label 에 필요한 처리를 붙인다.
   *
   * 파일 선택 중에는 안드로이드가 앱을 메모리에서 내릴 수 있다. 그러면 돌아왔을 때
   * 화면이 처음부터 다시 시작되고 작성 중이던 메모가 사라진다(첨부가 조용히 무시되는
   * 원인이었다). 그래서 고르기 전에 초안을 남겨 두고, 다시 시작되면 복원한다.
   */
  function bindFilePickerLabel(label, input, kind) {
    // 앱이면 앱이 직접 고르고 읽는다. 웹 파일 입력을 거치면 기기에 따라 결과가
    // 화면까지 오지 않아 첨부가 조용히 사라졌다.
    if (nativeAttachAvailable()) {
      label.removeAttribute("for"); // 파일 입력이 같이 열리지 않게 끊는다
      label.addEventListener("click", function () {
        if (label.getAttribute("aria-disabled") === "true") return;
        requestNativeAttachment(kind);
      });
      label.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (label.getAttribute("aria-disabled") === "true") return;
        requestNativeAttachment(kind);
      });
      return;
    }

    label.addEventListener("click", function () {
      rememberPendingMemoDraft();
    });

    // label 은 키보드 Enter/Space 로 눌리지 않는다. 직접 열어 준다.
    label.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (label.getAttribute("aria-disabled") === "true") return;
      rememberPendingMemoDraft();
      input.click();
    });
  }

  function onAttachmentPicked(event) {
    var input = event.target;
    var files = Array.prototype.slice.call(input.files || []);
    // 같은 파일을 연달아 고를 수 있게 입력값을 비운다.
    input.value = "";
    if (files.length === 0) return;
    addFilesToDraft(files);
  }

  // ---------- 앱에서 넘어오는 첨부 받기 ----------

  function nativeAttachAvailable() {
    var bridge = window.AndroidBridge;
    return !!(bridge && typeof bridge.pickAttachment === "function");
  }

  function requestNativeAttachment(kind) {
    rememberPendingMemoDraft();
    try {
      window.AndroidBridge.pickAttachment(kind === "video" ? "video" : "image");
    } catch (e) {
      toast("파일 선택 창을 열 수 없습니다: " + ((e && e.message) || e), 6000);
    }
  }

  /**
   * 앱이 파일을 조각으로 밀어 넣는 창구.
   *
   * 앱은 begin → chunk(여러 번) → end 순서로 부른다. 각 함수는 "ok" 를 돌려주고,
   * 앱은 그 값으로 화면이 살아 있는지 확인한다.
   */
  function setupNativeAttachReceiver() {
    var jobs = Object.create(null);

    function decode(base64) {
      var binary = atob(base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    window.RtlocNativeAttach = {
      begin: function (id, name, type, size) {
        jobs[id] = { name: name || "첨부", type: type || "", size: size || 0, parts: [], bytes: 0 };
        if (size > 4 * 1024 * 1024) toast("파일을 가져오는 중입니다. 잠시만 기다려 주세요.", 5000);
        return "ok";
      },

      chunk: function (id, base64) {
        var job = jobs[id];
        if (!job) return "no-job";
        try {
          var bytes = decode(base64);
          job.parts.push(bytes);
          job.bytes += bytes.length;
        } catch (e) {
          delete jobs[id];
          toast("첨부를 받는 중 오류가 났습니다: " + ((e && e.message) || e), 7000);
          return "error";
        }
        return "ok";
      },

      end: function (id) {
        var job = jobs[id];
        delete jobs[id];
        if (!job) return "no-job";

        try {
          var blob = new Blob(job.parts, { type: job.type || "application/octet-stream" });
          var file;
          try {
            file = new File([blob], job.name, { type: blob.type });
          } catch (e) {
            // File 생성자가 없는 옛 WebView 대비
            file = blob;
            file.name = job.name;
          }
          addFilesToDraft([file]);
        } catch (e) {
          toast("첨부를 만들지 못했습니다: " + ((e && e.message) || e), 7000);
        }
        return "ok";
      },

      fail: function (id, reason) {
        delete jobs[id];
        toast("첨부를 가져오지 못했습니다: " + (reason || "알 수 없는 이유"), 7000);
        return "ok";
      }
    };
  }

  /** 고른 파일들을 작성 중인 메모에 넣는다. 웹/앱 두 경로가 함께 쓴다. */
  function addFilesToDraft(files) {
    if (!files || files.length === 0) return;

    if (!state.memoDraft) {
      toast("메모 작성 창이 닫혀 첨부를 넣을 수 없습니다. 메모를 다시 열고 첨부해 주세요.", 7000);
      return;
    }

    var draft = state.memoDraft;
    setAttachButtonsBusy(true);

    // 사진은 팀 전송이 현실적인 크기로 줄인 뒤 첨부한다.
    Promise.all(files.map(prepareAttachment))
      .then(function (items) {
        setAttachButtonsBusy(false);
        // 처리 중에 창을 닫았으면 버린다.
        if (state.memoDraft !== draft) return;

        var added = 0;
        var unreadable = 0;

        items.forEach(function (item) {
          if (!item.blob || item.size === 0) {
            unreadable += 1;
            return;
          }
          draft.media.push(item);
          added += 1;

          if (item.size > RtlocMedia.LARGE_FILE_WARNING) {
            toast(
              item.name + " 은(는) " + formatBytes(item.size) +
                " 입니다. 팀원에게 전송되는 데 " + RtlocMedia.estimateSeconds(item.size) +
                "초 이상 걸릴 수 있습니다.",
              7000
            );
          }
        });

        renderDraftAttachments();

        if (unreadable > 0) {
          toast(
            "파일 " + unreadable + "개를 읽을 수 없어 제외했습니다. 다른 앱(갤러리 등)에서 고르거나 " +
              "다시 촬영해 주세요.",
            7000
          );
        }
        if (added > 0) toast(added + "개를 첨부했습니다. 저장을 눌러야 기록됩니다.");
      })
      .catch(function (err) {
        setAttachButtonsBusy(false);
        // 예전에는 여기서 조용히 끝나 "첨부가 안 된다"로 보였다.
        toast("첨부 처리 실패: " + ((err && err.message) || err), 7000);
      });
  }

  /** 파일 하나를 첨부 항목으로 만든다. 어떤 값이 빠져 있어도 던지지 않는다. */
  function prepareAttachment(file) {
    var srcName = (file && file.name) || "";
    var srcType = (file && file.type) || "";

    return RtlocMedia.shrinkImage(file).then(function (blob) {
      var out = blob || file;
      var type = (out && out.type) || srcType || guessTypeFromName(srcName);
      return {
        mediaId: RtlocMemo.newId(),
        name: srcName || (type.indexOf("video") === 0 ? "동영상" : "사진"),
        type: type,
        size: out && typeof out.size === "number" ? out.size : 0,
        blob: out,
        originalSize: (file && file.size) || 0
      };
    });
  }

  /** 파일 이름의 확장자로 종류를 추측한다(일부 기기는 type 을 비워서 준다). */
  function guessTypeFromName(name) {
    var ext = String(name).toLowerCase().split(".").pop();
    if (["mp4", "mov", "3gp", "mkv", "avi", "webm"].indexOf(ext) >= 0) return "video/" + ext;
    if (["jpg", "jpeg"].indexOf(ext) >= 0) return "image/jpeg";
    if (["png", "webp", "gif", "heic", "heif"].indexOf(ext) >= 0) return "image/" + ext;
    return "application/octet-stream";
  }

  function setAttachButtonsBusy(busy) {
    // label 에는 disabled 가 없다. aria-disabled 로 표시하고 CSS 로 클릭을 막는다.
    el.memoPhotoBtn.setAttribute("aria-disabled", String(busy));
    el.memoVideoBtn.setAttribute("aria-disabled", String(busy));
    el.memoPhotoBtn.textContent = busy ? "처리 중..." : "사진 첨부";
    el.memoVideoBtn.textContent = busy ? "처리 중..." : "동영상 첨부";
  }

  // ---------- 메모: 작성 중이던 초안 지키기 ----------

  function rememberPendingMemoDraft() {
    if (!state.memoDraft) return;
    try {
      sessionStorage.setItem(
        MEMO_DRAFT_KEY,
        JSON.stringify({
          id: state.memoDraft.id,
          teamKey: state.topic,
          lat: state.memoDraft.lat,
          lng: state.memoDraft.lng,
          text: el.memoText.value,
          savedAt: Date.now()
        })
      );
    } catch (e) {
      /* 저장 공간이 없으면 복원을 포기한다. 첨부 자체에는 영향이 없다. */
    }
  }

  function forgetPendingMemoDraft() {
    try {
      sessionStorage.removeItem(MEMO_DRAFT_KEY);
    } catch (e) {
      /* 무시 */
    }
  }

  function restorePendingMemoDraft() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(MEMO_DRAFT_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    forgetPendingMemoDraft();

    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!saved || saved.teamKey !== state.topic) return;
    if (typeof saved.lat !== "number" || typeof saved.lng !== "number") return;
    // 오래된 초안은 되살리지 않는다.
    if (Date.now() - (saved.savedAt || 0) > 30 * 60 * 1000) return;

    openMemoEditor({
      id: saved.id || RtlocMemo.newId(),
      teamKey: state.topic,
      lat: saved.lat,
      lng: saved.lng,
      text: saved.text || "",
      createdAt: Date.now(),
      author: state.callsign,
      authorId: state.clientId,
      remote: false,
      media: []
    });
    toast("파일을 고르는 동안 앱이 다시 시작돼 작성 중이던 메모를 되살렸습니다. 첨부를 다시 골라 주세요.", 8000);
  }

  function renderDraftAttachments() {
    var media = (state.memoDraft && state.memoDraft.media) || [];
    el.memoAttachments.innerHTML = "";

    media.forEach(function (item, index) {
      var li = document.createElement("li");
      li.className = "attachment";

      var label = document.createElement("span");
      label.className = "attachment-name";
      var shrunk =
        item.originalSize && item.originalSize > item.size
          ? " ← " + formatBytes(item.originalSize) + " 축소"
          : "";
      label.textContent =
        (String(item.type || "").indexOf("video") === 0 ? "동영상 · " : "사진 · ") +
        item.name +
        " (" +
        formatBytes(item.size) +
        shrunk +
        ")";

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ghost small danger";
      removeBtn.textContent = "제거";
      removeBtn.addEventListener("click", function () {
        state.memoDraft.media.splice(index, 1);
        renderDraftAttachments();
      });

      li.appendChild(label);
      li.appendChild(removeBtn);
      el.memoAttachments.appendChild(li);
    });
  }

  function saveMemoDraft() {
    var memo = state.memoDraft;
    if (!memo) return;

    memo.text = el.memoText.value.trim();
    if (!memo.text && memo.media.length === 0) {
      toast("메모 내용이나 첨부 중 하나는 있어야 합니다.");
      el.memoText.focus();
      return;
    }

    el.memoSave.disabled = true;
    RtlocMemo.put(memo)
      .then(function () {
        el.memoSave.disabled = false;
        closeMemoEditor();
        addMemoMarker(memo);
        updateMemoCount();
        // 좌표와 본문은 팀에 공유한다(첨부는 목록만).
        publish({ type: "memo", action: "add", id: state.clientId, memo: RtlocMemo.toWire(memo) });
        // 첨부는 브로커 보관함에 올려 둔다. 내가 접속을 끊어도 팀원이 받을 수 있다.
        stashMemoMedia(memo, true);
        toast("메모를 저장했습니다. 팀원에게 위치와 내용을 공유했습니다.");
      })
      .catch(function (err) {
        el.memoSave.disabled = false;
        toast("메모 저장 실패: " + err.message, 6000);
      });
  }

  // ---------- 메모: 지도 표시 ----------
  function loadMemos() {
    RtlocMemo.listByTeam(state.topic)
      .then(function (memos) {
        memos.forEach(function (memo) {
          // 예전 버전에서 저장된 첨부는 mediaId 가 없어 전송 요청을 짝지을 수 없다.
          // 지금 채워서 다시 저장해 두면 팀원이 요청했을 때 응답할 수 있다.
          if (!memo.remote && RtlocMemo.ensureMediaIds(memo)) {
            RtlocMemo.put(memo);
          }
          addMemoMarker(memo);
          // 예전에 못 받은 사진이 있으면 지금 받아 둔다.
          if (memo.remote) queueAutoFetch(memo);
        });
        updateMemoCount();
      })
      .catch(function (err) {
        toast("저장된 메모를 불러올 수 없습니다: " + err.message, 6000);
      });
  }

  function addMemoMarker(memo) {
    var existing = state.memos[memo.id];
    if (existing) {
      existing.memo = memo;
      existing.marker.setPosition([memo.lat, memo.lng]);
      return;
    }

    var marker = RtlocMap.marker({
      position: [memo.lat, memo.lng],
      html:
        '<div class="memo-pin' +
        (memo.remote ? " memo-pin--remote" : "") +
        '"><span>메모</span></div>',
      size: [42, 34],
      anchor: [21, 34],
      zIndex: 500
    });

    marker.addTo(state.map);
    marker.onClick(function () {
      openMemoDetail(memo.id);
    });

    state.memos[memo.id] = { memo: memo, marker: marker };
  }

  function removeMemoMarker(id) {
    var entry = state.memos[id];
    if (!entry) return;
    entry.marker.remove();
    delete state.memos[id];
  }

  /**
   * 내가 만든 메모를 팀에 다시 알린다(새 대원 합류 시).
   * 채널을 막지 않도록 최신 30건으로 제한하고 조금씩 나눠 보낸다.
   */
  function shareOwnMemos() {
    var mine = Object.keys(state.memos)
      .map(function (id) {
        return state.memos[id].memo;
      })
      .filter(function (memo) {
        return !memo.remote;
      })
      .sort(function (a, b) {
        return b.createdAt - a.createdAt;
      })
      .slice(0, 30);

    mine.forEach(function (memo, index) {
      setTimeout(function () {
        publish({ type: "memo", action: "add", id: state.clientId, memo: RtlocMemo.toWire(memo) });
      }, index * 150);
    });
  }

  function updateMemoCount() {
    el.memoCount.textContent = String(Object.keys(state.memos).length);
  }

  // ---------- 메모: 상세 ----------
  function openMemoDetail(id) {
    var entry = state.memos[id];
    if (!entry) return;

    // 최신 내용을 저장소에서 다시 읽는다(첨부 포함).
    RtlocMemo.get(id).then(function (stored) {
      var memo = stored || entry.memo;
      entry.memo = memo;
      state.memoDetailId = id;

      renderCoords(el.memoDetailCoords, memo.lat, memo.lng, memo);
      el.memoDetailText.textContent = memo.text || "(메모 내용 없음)";
      renderDetailMedia(memo);

      if (memo.remote) {
        el.memoDetailNote.hidden = false;
        el.memoDetailNote.textContent =
          "팀원이 작성한 메모입니다. 첨부는 그 파일을 가진 대원이 접속 중일 때 자동으로 받아옵니다.";
        el.memoEdit.hidden = true;

        // 첨부 목록을 작성자에게 다시 확인한다.
        // 예전 버전에서 저장된 메모나, 목록 메시지를 놓친 경우를 스스로 복구한다.
        publish({
          type: "media",
          action: "list",
          id: state.clientId,
          memoId: memo.id,
          ownerId: memo.authorId
        });
      } else {
        el.memoDetailNote.hidden = true;
        el.memoEdit.hidden = false;
      }

      // 아직 못 받은 첨부가 있으면 작성자에게 전송을 요청한다.
      requestMissingMedia(memo);

      el.memoEdit.onclick = function () {
        closeMemoDetail();
        openMemoEditor(memo);
      };
      el.memoDelete.onclick = function () {
        deleteMemo(memo);
      };
      el.memoCopy.onclick = function () {
        copyCoords(memo);
      };

      el.memoDetailModal.hidden = false;
    });
  }

  function closeMemoDetail() {
    el.memoDetailModal.hidden = true;
    releaseObjectUrls();
  }

  function releaseObjectUrls() {
    state.memoObjectUrls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
    state.memoObjectUrls = [];
  }

  function renderDetailMedia(memo) {
    releaseObjectUrls();
    el.memoDetailMedia.innerHTML = "";

    (memo.media || []).forEach(function (item) {
      var li = document.createElement("li");
      li.className = "attachment attachment--preview";
      li.setAttribute("data-media-id", item.mediaId || "");

      // 아직 파일을 받지 못한 첨부는 자리표시자와 진행 상태를 보여준다.
      if (!item.blob) {
        var placeholder = document.createElement("div");
        placeholder.className = "attachment-pending";
        placeholder.textContent =
          (item.type.indexOf("video") === 0 ? "동영상" : "사진") +
          " · " + item.name + " (" + formatBytes(item.size) + ")";

        var progress = document.createElement("div");
        progress.className = "attachment-progress";
        progress.textContent = "첨부를 가져오는 중… 보관함을 먼저 확인합니다.";

        var retry = document.createElement("button");
        retry.type = "button";
        retry.className = "ghost small";
        retry.textContent = "다시 요청";
        retry.addEventListener("click", function () {
          delete state.mediaRequested[item.mediaId];
          progress.textContent = "다시 요청했습니다…";
          requestMedia(memo, item);
        });

        li.appendChild(placeholder);
        li.appendChild(progress);
        li.appendChild(retry);
        el.memoDetailMedia.appendChild(li);
        return;
      }

      var url = URL.createObjectURL(item.blob);
      state.memoObjectUrls.push(url);

      if (item.type.indexOf("video") === 0) {
        var video = document.createElement("video");
        video.src = url;
        video.controls = true;
        video.preload = "metadata";
        li.appendChild(video);
      } else {
        var link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        var img = document.createElement("img");
        img.src = url;
        img.alt = item.name;
        img.loading = "lazy";
        link.appendChild(img);
        li.appendChild(link);
      }

      var caption = document.createElement("span");
      caption.className = "attachment-name";
      caption.textContent = item.name + " (" + formatBytes(item.size) + ")";
      li.appendChild(caption);

      el.memoDetailMedia.appendChild(li);
    });
  }

  // ---------- 메모: 첨부 전송 ----------
  /** 아직 받지 못한 첨부를 가져온다. */
  function requestMissingMedia(memo) {
    (memo.media || []).forEach(function (item) {
      if (item.blob || !item.mediaId) return;
      requestMedia(memo, item);
    });
  }

  /**
   * 첨부 가져오기.
   *
   * 먼저 브로커 보관함을 본다. 올린 대원이 접속 중이 아니어도 여기서 받을 수 있다.
   * 보관함에 없으면(용량이 커서 안 올라간 경우 등) 접속 중인 대원에게 요청한다.
   */
  function requestMedia(memo, item) {
    if (state.mediaRequested[item.mediaId]) return;
    state.mediaRequested[item.mediaId] = true;
    state.mediaOwnerMemo[item.mediaId] = memo.id;

    fetchFromVault(memo, item);
  }

  /** 접속 중인 대원에게 직접 요청한다(보관함에 없을 때의 대비책). */
  function requestFromTeam(memo, item) {
    updateMediaProgress(item.mediaId, "접속 중인 대원에게 요청했습니다…");
    publish({
      type: "media",
      action: "req",
      id: state.clientId,
      memoId: memo.id,
      mediaId: item.mediaId,
      ownerId: memo.authorId
    });
  }

  // ---------- 첨부 보관함 (브로커 retained 메시지) ----------
  //
  // 서버가 없어도 파일이 남아 있게 하는 방법.
  // 조각마다 고유한 토픽에 retain 표시를 달아 발행하면, 브로커가 마지막 값을 들고 있다가
  // 나중에 그 토픽을 구독하는 대원에게 그대로 전달한다. 올린 대원이 접속을 끊어도
  // 파일이 유지된다. 내용은 팀 암호로 암호화된 채로 올라가므로 브로커는 못 읽는다.

  function vaultTopic(mediaId, seq) {
    return state.topic + "/v/" + mediaId + "/" + seq;
  }

  function vaultFilter(mediaId) {
    return state.topic + "/v/" + mediaId + "/+";
  }

  function isVaultTopic(topic) {
    return topic.indexOf(state.topic + "/v/") === 0;
  }

  function publishRetained(topic, obj) {
    if (!state.client || !state.client.connected) return;
    var client = state.client;
    encryptMessage(obj)
      .then(function (envelope) {
        if (client.connected) client.publish(topic, envelope, { qos: 0, retain: true });
      })
      .catch(function () {
        // 암호화 실패 시에는 올리지 않는다.
      });
  }

  /** 보관함에서 지운다. 빈 내용을 retain 으로 보내면 브로커가 기억을 버린다. */
  function clearRetained(topic) {
    if (!state.client || !state.client.connected) return;
    state.client.publish(topic, "", { qos: 0, retain: true });
  }

  function stashedIds() {
    try {
      var raw = localStorage.getItem(VAULT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function markStashed(mediaId) {
    try {
      var list = stashedIds();
      if (list.indexOf(mediaId) >= 0) return;
      list.push(mediaId);
      // 무한정 늘어나지 않게 최근 것만 남긴다.
      if (list.length > 500) list = list.slice(list.length - 500);
      localStorage.setItem(VAULT_KEY, JSON.stringify(list));
    } catch (e) {
      /* 저장 공간이 없으면 다음 실행에서 다시 올릴 뿐이다 */
    }
  }

  /** 메모의 첨부를 보관함에 올린다. */
  function stashMemoMedia(memo, force) {
    (memo.media || []).forEach(function (item) {
      if (!item.blob || !item.mediaId) return;
      if (!force && stashedIds().indexOf(item.mediaId) >= 0) return;
      stashMedia(memo.id, item);
    });
  }

  function stashMedia(memoId, item) {
    if (state.vaultStashing[item.mediaId]) return;
    if (item.blob.size > state.vaultMaxBytes) {
      // 큰 파일은 브로커에 남기지 않는다. 조각이 너무 많아진다.
      return;
    }
    state.vaultStashing[item.mediaId] = true;

    var transfer = RtlocMedia.sendBlob(
      item.blob,
      { name: item.name, type: item.type },
      function (chunk) {
        publishRetained(vaultTopic(item.mediaId, chunk.seq), {
          type: "vault",
          id: state.clientId,
          memoId: memoId,
          mediaId: item.mediaId,
          chunk: chunk
        });
      }
    );

    transfer.promise.then(
      function () {
        delete state.vaultStashing[item.mediaId];
        markStashed(item.mediaId);
      },
      function () {
        delete state.vaultStashing[item.mediaId];
      }
    );
  }

  /** 보관함에 있던 첨부를 지운다(메모를 삭제할 때). */
  function clearMemoFromVault(memo) {
    (memo.media || []).forEach(function (item) {
      if (!item.mediaId) return;
      var size = item.blob ? item.blob.size : item.size;
      if (!size) return;
      var total = RtlocMedia.chunkCount(size);
      for (var seq = 0; seq < total; seq++) {
        clearRetained(vaultTopic(item.mediaId, seq));
      }
    });
  }

  /** 보관함을 구독해 조각을 받는다. 없으면 대원에게 요청으로 넘어간다. */
  function fetchFromVault(memo, item) {
    if (!state.client || !state.client.connected) {
      requestFromTeam(memo, item);
      return;
    }

    var mediaId = item.mediaId;
    updateMediaProgress(mediaId, "보관함에서 찾는 중…");
    state.vaultSubs[mediaId] = true;

    state.client.subscribe(vaultFilter(mediaId), { qos: 0 }, function (err) {
      if (err) {
        delete state.vaultSubs[mediaId];
        requestFromTeam(memo, item);
        return;
      }

      setTimeout(function () {
        // 보관함에서 아무 조각도 오지 않았으면 접속 중인 대원에게 요청한다.
        if (state.mediaFromVault[mediaId]) return;
        if (!state.mediaRequested[mediaId]) return; // 이미 받아서 끝난 경우
        requestFromTeam(memo, item);
      }, VAULT_WAIT);
    });
  }

  function releaseVault(mediaId) {
    if (!state.vaultSubs[mediaId]) return;
    delete state.vaultSubs[mediaId];
    if (state.client && state.client.connected) {
      state.client.unsubscribe(vaultFilter(mediaId));
    }
  }

  function handleVaultChunk(msg) {
    if (!msg || msg.type !== "vault" || !msg.chunk || !msg.mediaId) return;
    if (!state.vaultSubs[msg.mediaId]) return; // 지금 기다리는 첨부가 아니다

    state.mediaFromVault[msg.mediaId] = true;
    state.mediaOwnerMemo[msg.mediaId] = msg.memoId;
    ensureAssembler().accept(msg.mediaId, msg.chunk);
  }

  // ---------- 사진 미리 받아 두기 ----------
  //
  // 메모를 열어 볼 때 받는 방식만 쓰면, 보관함이 비워진 뒤에는 아무도 그 사진을 못 본다.
  // 사진은 작으니 도착하는 대로 미리 받아 둔다. 받아 둔 기기가 늘어날수록 팀 안에서
  // 파일이 사라질 일이 없어진다. 동영상은 용량 때문에 열어 볼 때만 받는다.

  function queueAutoFetch(memo) {
    (memo.media || []).forEach(function (item) {
      if (item.blob || !item.mediaId) return;
      if (String(item.type || "").indexOf("image") !== 0) return;
      if (item.size && item.size > AUTO_FETCH_MAX) return;
      if (state.mediaRequested[item.mediaId]) return;
      state.autoFetchQueue.push({ memoId: memo.id, mediaId: item.mediaId });
    });
    pumpAutoFetch();
  }

  function pumpAutoFetch() {
    if (state.autoFetchTimer) return;
    if (state.autoFetchQueue.length === 0) return;

    var next = state.autoFetchQueue.shift();
    // 한 번에 몰아 받지 않는다. 위치 공유가 밀리지 않게 간격을 둔다.
    state.autoFetchTimer = setTimeout(function () {
      state.autoFetchTimer = null;

      RtlocMemo.get(next.memoId)
        .then(function (memo) {
          if (!memo) return;
          (memo.media || []).forEach(function (item) {
            if (item.mediaId === next.mediaId && !item.blob) requestMedia(memo, item);
          });
        })
        .catch(function () {
          /* 다음 것으로 넘어간다 */
        })
        .then(pumpAutoFetch);
    }, AUTO_FETCH_GAP);
  }

  /**
   * 내가 가진 첨부 중 보관함에 없는 것을 올린다.
   *
   * 예전 버전에서 만든 메모, 그리고 다른 대원에게서 직접 받은 첨부가 대상이다.
   * 이렇게 해 두면 원래 올린 대원이 앱을 지워도 팀 안에 파일이 남는다.
   */
  function backfillVault() {
    RtlocMemo.listByTeam(state.topic)
      .then(function (memos) {
        var known = stashedIds();
        memos.forEach(function (memo) {
          (memo.media || []).forEach(function (item) {
            if (!item.blob || !item.mediaId) return;
            if (known.indexOf(item.mediaId) >= 0) return;
            stashMedia(memo.id, item);
          });
        });
      })
      .catch(function () {
        /* 보관함 채우기는 부가 기능이다 */
      });
  }

  /**
   * 첨부 목록을 요청한 대원에게 알려준다.
   *
   * 작성자 본인만 응답하게 만들면 안 된다. 대원 id 는 접속할 때마다 새로 만들어지므로
   * 작성자가 앱을 다시 열면 옛 id 로 온 요청에 아무도 답하지 않게 된다.
   * 그래서 그 파일을 가진 대원이면 누구든 응답한다(먼저 받은 대원이 중계).
   */
  function serveManifestRequest(msg) {
    RtlocMemo.get(msg.memoId).then(function (memo) {
      if (!memo) return;
      if (!memo.remote && RtlocMemo.ensureMediaIds(memo)) RtlocMemo.put(memo);

      // 내가 실제로 파일을 가진 첨부만 알려준다.
      var haveAny = (memo.media || []).some(function (item) {
        return !!item.blob;
      });
      if (!haveAny) return;

      publish({
        type: "media",
        action: "listed",
        id: state.clientId,
        to: msg.id,
        memoId: memo.id,
        manifest: RtlocMemo.manifestOf(memo).filter(function (item, index) {
          return !!memo.media[index].blob;
        })
      });
    });
  }

  /** 작성자가 알려준 첨부 목록을 반영하고 곧바로 파일을 요청한다. */
  function applyManifest(msg) {
    if (msg.to && msg.to !== state.clientId) return;

    RtlocMemo.get(msg.memoId).then(function (memo) {
      if (!memo) return;

      var added = RtlocMemo.mergeManifest(memo, msg.manifest);
      if (!added) {
        requestMissingMedia(memo);
        return;
      }

      RtlocMemo.put(memo).then(function () {
        var entry = state.memos[memo.id];
        if (entry) entry.memo = memo;
        if (state.memoDetailId === memo.id && !el.memoDetailModal.hidden) {
          renderDetailMedia(memo);
        }
        requestMissingMedia(memo);
      });
    });
  }

  /**
   * 요청 받은 첨부를 조각으로 나눠 보낸다.
   *
   * 파일을 가진 대원이 여러 명일 수 있으므로 짧게 무작위로 기다린 뒤,
   * 그 사이 다른 대원이 이미 보내기 시작했으면 양보한다. 중복 전송으로
   * 채널을 두 배로 쓰는 것을 막기 위함이다.
   */
  function serveMediaRequest(msg) {
    RtlocMemo.findMedia(msg.memoId, msg.mediaId).then(function (item) {
      if (!item || !item.blob) return; // 내가 가진 파일이 아니면 조용히 넘어간다

      var requester = msg.id;
      var mediaId = msg.mediaId;
      var waited = 150 + Math.floor(Math.random() * 700);

      setTimeout(function () {
        // 다른 대원이 이미 이 첨부를 보내고 있으면 중복 전송하지 않는다.
        if (state.chunkSeen[mediaId] && Date.now() - state.chunkSeen[mediaId] < 5000) return;
        if (state.mediaSending[mediaId]) return;
        state.mediaSending[mediaId] = true;

        var transfer = RtlocMedia.sendBlob(
          item.blob,
          { name: item.name, type: item.type },
          function (chunk) {
            publish({
              type: "media",
              action: "chunk",
              id: state.clientId,
              to: requester,
              memoId: msg.memoId,
              mediaId: mediaId,
              chunk: chunk
            });
          },
          function (sent, total) {
            if (sent === 1) toast(item.name + " 전송 시작 (" + total + "조각)", 3000);
            else if (sent === total) toast(item.name + " 전송 완료", 3000);
          }
        );

        transfer.promise.then(
          function () {
            delete state.mediaSending[mediaId];
          },
          function () {
            delete state.mediaSending[mediaId];
          }
        );
      }, waited);
    });
  }

  function ensureAssembler() {
    if (state.assembler) return state.assembler;

    state.assembler = RtlocMedia.createAssembler(
      // 완성
      function (mediaId, info) {
        var memoId = state.mediaOwnerMemo[mediaId];
        releaseVault(mediaId);
        delete state.mediaRequested[mediaId];
        if (!memoId) return;

        // 대원에게 직접 받은 파일이면 보관함에도 올려 둔다.
        // 다음에 누가 열 때는 아무도 접속해 있지 않아도 받을 수 있다.
        if (!state.mediaFromVault[mediaId]) {
          stashMedia(memoId, {
            mediaId: mediaId,
            name: info.name,
            type: info.type,
            blob: info.blob
          });
        }

        RtlocMemo.attachMedia(memoId, mediaId, info).then(function () {
          var entry = state.memos[memoId];
          if (entry) {
            entry.memo.media = (entry.memo.media || []).map(function (item) {
              return item.mediaId === mediaId
                ? {
                    mediaId: mediaId,
                    name: info.name || item.name,
                    type: info.type || item.type,
                    size: info.blob.size,
                    blob: info.blob
                  }
                : item;
            });
          }

          // 지금 보고 있는 메모라면 즉시 화면을 갱신한다.
          if (state.memoDetailId === memoId && !el.memoDetailModal.hidden && entry) {
            renderDetailMedia(entry.memo);
          }
          toast((info.name || "첨부") + " 을(를) 받았습니다.", 3000);
        });
      },
      // 실패
      function (mediaId, reason) {
        delete state.mediaRequested[mediaId];
        delete state.mediaFromVault[mediaId];
        releaseVault(mediaId);
        updateMediaProgress(mediaId, reason + ". '다시 요청'을 눌러 보세요.");
      },
      // 진행률
      function (mediaId, received, total) {
        var percent = Math.round((received / total) * 100);
        updateMediaProgress(mediaId, "전송 받는 중 " + percent + "% (" + received + "/" + total + ")");
      }
    );

    return state.assembler;
  }

  function updateMediaProgress(mediaId, text) {
    var li = el.memoDetailMedia.querySelector('[data-media-id="' + mediaId + '"]');
    if (!li) return;
    var progress = li.querySelector(".attachment-progress");
    if (progress) progress.textContent = text;
  }

  function deleteMemo(memo) {
    if (!window.confirm("이 메모를 삭제할까요? 첨부 파일도 함께 지워집니다.")) return;

    // 보관함에 남은 조각까지 지운다. 안 그러면 브로커에 계속 남는다.
    clearMemoFromVault(memo);

    RtlocMemo.remove(memo.id).then(function () {
      removeMemoMarker(memo.id);
      updateMemoCount();
      closeMemoDetail();
      if (!memo.remote) {
        publish({ type: "memo", action: "remove", id: state.clientId, memoId: memo.id });
      }
      toast("메모를 삭제했습니다.");
    });
  }

  function copyCoords(memo) {
    var text =
      "위도 " + memo.lat.toFixed(6) + ", 경도 " + memo.lng.toFixed(6) +
      " / 군사좌표 " + (RtlocMgrs.toMgrs(memo.lat, memo.lng, 5, true) || "해당 없음");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast("좌표를 복사했습니다.");
        },
        function () {
          toast("복사에 실패했습니다. 화면의 값을 직접 옮겨 적어 주세요.", 5000);
        }
      );
    } else {
      toast("이 브라우저에서는 자동 복사를 지원하지 않습니다.", 5000);
    }
  }

  /** 위도/경도/군사좌표/UTM 을 표 형태로 렌더링한다. */
  function renderCoords(container, lat, lng, memo) {
    container.innerHTML = "";

    function row(label, value) {
      var dt = document.createElement("dt");
      dt.textContent = label;
      var dd = document.createElement("dd");
      dd.textContent = value;
      container.appendChild(dt);
      container.appendChild(dd);
    }

    row("위도", lat.toFixed(6) + "  (" + RtlocMgrs.toDms(lat, true) + ")");
    row("경도", lng.toFixed(6) + "  (" + RtlocMgrs.toDms(lng, false) + ")");

    var mgrs = RtlocMgrs.toMgrs(lat, lng, 5, true);
    row("군사좌표 (MGRS)", mgrs || "극지방은 지원하지 않습니다");

    var utm = RtlocMgrs.toUtm(lat, lng);
    row(
      "UTM",
      utm.zone + utm.band + " E " + Math.round(utm.easting) + " N " + Math.round(utm.northing)
    );

    if (memo) {
      row("작성자", memo.author || "알 수 없음");
      row("작성 시각", formatDateTime(new Date(memo.createdAt)));
    }
  }

  // ---------- 메모: 목록 ----------
  function openMemoList() {
    var entries = Object.keys(state.memos).map(function (id) {
      return state.memos[id].memo;
    });

    entries.sort(function (a, b) {
      return b.createdAt - a.createdAt;
    });

    el.memoList.innerHTML = "";
    el.memoListEmpty.hidden = entries.length > 0;

    entries.forEach(function (memo) {
      var li = document.createElement("li");
      li.className = "history-item";

      var title = document.createElement("div");
      title.className = "history-title";
      title.textContent = memo.text ? truncate(memo.text, 40) : "(첨부만 있는 메모)";

      var meta = document.createElement("div");
      meta.className = "history-meta";
      var mediaCount = (memo.media || []).length;
      meta.textContent =
        (RtlocMgrs.toMgrs(memo.lat, memo.lng, 4, true) || "") +
        " · " +
        formatDateTime(new Date(memo.createdAt)) +
        " · " +
        (memo.author || "알 수 없음") +
        (mediaCount ? " · 첨부 " + mediaCount + "건" : "");

      var actions = document.createElement("div");
      actions.className = "history-actions";
      actions.appendChild(
        makeSmallButton("지도에서 보기", function () {
          el.memoListModal.hidden = true;
          setFollow(false);
          state.map.setView([memo.lat, memo.lng], Math.max(state.map.getZoom(), 17));
          openMemoDetail(memo.id);
        })
      );
      actions.appendChild(
        makeSmallButton("상세", function () {
          el.memoListModal.hidden = true;
          openMemoDetail(memo.id);
        })
      );

      li.appendChild(title);
      li.appendChild(meta);
      li.appendChild(actions);
      el.memoList.appendChild(li);
    });

    el.memoListModal.hidden = false;
  }

  function truncate(text, max) {
    var flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max) + "…" : flat;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0B";
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + "KB";
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  }

  // ---------- 임무 ----------
  function startMission(remote, isLocal) {
    if (state.recorder) return;

    state.recorder = RtlocMission.createRecorder({
      missionId: remote ? remote.missionId : RtlocMission.newId(),
      startedAt: remote ? remote.at : Date.now(),
      teamName: state.teamName,
      teamKey: state.topic
    });

    el.missionStartBtn.hidden = true;
    el.missionEndBtn.hidden = false;
    el.missionClock.hidden = false;
    clearHistoryLayer();
    updateClock();
    state.clockTimer = setInterval(updateClock, 1000);

    // 이미 알고 있는 위치를 경로의 첫 점으로 넣어 둔다.
    Object.keys(state.members).forEach(function (id) {
      var m = state.members[id];
      state.recorder.addPoint(id, m.name, m.lat, m.lng, m.updatedAt);
      drawTrail(m);
    });

    if (isLocal) {
      publish({
        type: "mission",
        action: "start",
        id: state.clientId,
        name: state.callsign,
        missionId: state.recorder.missionId,
        at: state.recorder.startedAt
      });
      toast("임무를 시작했습니다. 대원들의 이동 경로를 기록합니다.");
    } else {
      toast((remote.name || "대원") + " 님이 임무를 시작했습니다.", 5000);
    }
  }

  function endMission(isLocal) {
    if (!state.recorder) return;

    var recorder = state.recorder;
    state.recorder = null;

    clearInterval(state.clockTimer);
    state.clockTimer = null;
    el.missionEndBtn.hidden = true;
    el.missionStartBtn.hidden = false;
    el.missionClock.hidden = true;

    if (!isLocal) {
      // 다른 대원이 종료한 경우. 기록만 멈추고 저장 창은 띄우지 않는다.
      // 저장 여부는 종료를 누른 대원이 자기 기기에서만 정한다.
      return;
    }

    publish({
      type: "mission",
      action: "end",
      id: state.clientId,
      name: state.callsign,
      missionId: recorder.missionId,
      at: Date.now()
    });

    var colors = {};
    Object.keys(state.members).forEach(function (id) {
      colors[id] = state.members[id].color;
    });

    state.pendingMission = recorder.finish({ colors: colors });
    openSaveDialog();
  }

  function updateClock() {
    if (!state.recorder) return;
    var elapsed = Date.now() - state.recorder.startedAt;
    el.missionClock.textContent = "임무 " + formatDuration(elapsed);
  }

  // ---------- 임무 저장 창 ----------
  function openSaveDialog() {
    var mission = state.pendingMission;
    if (!mission) return;

    var summary = RtlocMission.summarize(mission);
    var started = new Date(mission.startedAt);
    var ended = new Date(mission.endedAt);

    el.missionNameInput.value =
      state.teamName + " " + formatDateTime(started).replace(/:\d\d$/, "");

    el.saveSummary.innerHTML = "";
    addSummaryRow("임무 날짜", formatDate(started));
    addSummaryRow("시작 시각", formatTime(started));
    addSummaryRow("종료 시각", formatTime(ended));
    addSummaryRow("소요 시간", formatDuration(summary.durationMs));
    addSummaryRow("참여 대원", summary.memberCount + "명");
    addSummaryRow("총 이동 거리", formatDistance(summary.totalDistance));
    addSummaryRow("기록된 위치", summary.pointCount.toLocaleString("ko-KR") + "개");

    mission.tracks.forEach(function (track) {
      addSummaryRow(
        track.name,
        formatDistance(track.distance) + " · 위치 " + track.points.length + "개",
        track.color
      );
    });

    if (mission.truncated) {
      addSummaryRow("참고", "기록이 매우 길어 일부 지점이 솎아졌습니다.");
    }

    setupVideoChoice(summary);

    el.saveModal.hidden = false;
    el.missionNameInput.focus();
    el.missionNameInput.select();
  }

  /**
   * 저장 창의 "MP4로 변환하여 저장" 선택지를 이 기기 사정에 맞게 준비한다.
   * 브라우저가 녹화를 못하거나 그릴 경로가 없으면 고를 수 없게 막는다.
   */
  function setupVideoChoice(summary) {
    resetVideoProgress();

    var video = window.RtlocRouteVideo;
    var seconds = video ? video.PLAY_SEC + video.TAIL_SEC : 22;
    el.saveVideoSeconds.textContent = String(seconds);

    if (!video || !video.isSupported()) {
      // 녹화가 불가능한 브라우저. 선택지를 숨기고 저장 버튼만 남긴다.
      el.saveVideo.hidden = true;
      el.saveVideoHelp.hidden = true;
      el.saveConfirm.textContent = "저장";
      el.saveConfirm.className = "primary";
      return;
    }

    var mp4 = video.willBeMp4();
    el.saveVideo.hidden = false;
    el.saveVideoHelp.hidden = false;
    el.saveVideo.textContent = mp4 ? "MP4로 변환하여 저장" : "영상(WebM)으로 변환하여 저장";
    el.saveConfirm.textContent = mp4 ? "MP4 변환 안 하고 저장" : "영상 변환 안 하고 저장";
    el.saveConfirm.className = "ghost";

    if (!summary || summary.pointCount === 0) {
      // 점이 없으면 그릴 게 없다. 버튼은 남겨 두고 이유를 알려 준다.
      el.saveVideo.disabled = true;
      el.saveVideo.title = "기록된 이동 경로가 없어 영상을 만들 수 없습니다.";
    } else {
      el.saveVideo.disabled = false;
      el.saveVideo.title = mp4
        ? "MP4 파일로 만들어 기기에 저장합니다."
        : "이 브라우저는 MP4를 만들 수 없어 WebM으로 저장됩니다.";
    }
  }

  function resetVideoProgress() {
    state.videoRendering = false;
    el.saveVideoProgress.hidden = true;
    el.saveVideoFill.style.width = "0%";
    el.saveVideoStatus.textContent = "준비 중…";
    el.saveVideoError.hidden = true;
    el.saveVideoError.textContent = "";
    hideManualSaveLink();
    setSaveButtonsDisabled(false);
  }

  function showSaveError(message) {
    el.saveVideoError.textContent = message;
    el.saveVideoError.hidden = false;
  }

  /** 자동 저장이 막힌 기기를 위해 직접 누를 수 있는 링크를 띄운다. */
  function showManualSaveLink(blob, fileName) {
    hideManualSaveLink();
    var url = URL.createObjectURL(blob);
    state.manualSaveUrl = url;
    el.saveVideoLink.href = url;
    el.saveVideoLink.download = fileName;
    el.saveVideoLink.textContent = fileName;
    el.saveVideoManual.hidden = false;
  }

  function hideManualSaveLink() {
    el.saveVideoManual.hidden = true;
    el.saveVideoLink.removeAttribute("href");
    if (state.manualSaveUrl) {
      URL.revokeObjectURL(state.manualSaveUrl);
      state.manualSaveUrl = null;
    }
  }

  function setSaveButtonsDisabled(on) {
    el.saveVideo.disabled = on;
    el.saveConfirm.disabled = on;
    el.saveDiscard.disabled = on;
    el.missionNameInput.disabled = on;
  }

  function addSummaryRow(label, value, color) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    if (color) {
      var dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      dt.prepend(dot);
    }
    var dd = document.createElement("dd");
    dd.textContent = value;
    el.saveSummary.appendChild(dt);
    el.saveSummary.appendChild(dd);
  }

  function confirmSave() {
    var mission = state.pendingMission;
    if (!mission) return;

    mission.name = el.missionNameInput.value.trim() || state.teamName + " 임무";

    var result = RtlocMission.storage.save(state.topic, mission);
    if (!result.ok) {
      showSaveError(result.error);
      return;
    }

    el.saveModal.hidden = true;
    state.pendingMission = null;
    resetVideoProgress();
    toast(
      "임무를 저장했습니다." + (result.evicted ? " 공간 확보를 위해 오래된 기록을 지웠습니다." : ""),
      4000
    );
  }

  /**
   * 기록을 저장한 뒤 이동 경로 영상을 만들어 내려받는다.
   *
   * 저장을 먼저 끝내는 이유는 영상 만들기가 실패해도 기록은 남아야 하기 때문이다.
   * 녹화는 실제 재생 시간만큼 걸리므로 그동안 창을 닫지 못하게 버튼을 잠근다.
   */
  function saveWithVideo() {
    var mission = state.pendingMission;
    if (!mission || state.videoRendering) return;

    var video = window.RtlocRouteVideo;
    if (!video || !video.isSupported()) {
      toast("이 브라우저는 영상 만들기를 지원하지 않습니다. 영상 없이 저장해 주세요.", 6000);
      return;
    }

    mission.name = el.missionNameInput.value.trim() || state.teamName + " 임무";

    var result = RtlocMission.storage.save(state.topic, mission);
    if (!result.ok) {
      toast(result.error, 6000);
      return;
    }

    state.videoRendering = true;
    setSaveButtonsDisabled(true);
    el.saveVideoProgress.hidden = false;
    el.saveVideoFill.style.width = "0%";
    el.saveVideoStatus.textContent = "준비 중… 이 화면을 그대로 두세요.";

    video
      .render(mission, {
        onProgress: function (pct, phase) {
          el.saveVideoFill.style.width = pct + "%";
          el.saveVideoStatus.textContent = phase + " " + pct + "%  (화면을 그대로 두세요)";
        }
      })
      .then(function (out) {
        var fileName = safeFileName(mission.name) + "." + out.ext;
        el.saveVideoStatus.textContent = "파일로 저장하는 중… " + formatBytes(out.blob.size);

        return saveFile(out.blob, fileName, out.mime).then(function (how) {
          var note = "임무를 저장하고 " + out.ext.toUpperCase() + " 영상을 만들었습니다.";
          if (how === "android") {
            note += " 기기의 다운로드 폴더에 넣었습니다.";
          } else {
            note += " 내려받기 폴더를 확인하세요.";
          }
          if (out.tilesLoaded === 0) {
            note += " 지도 배경을 받지 못해 격자만 그려졌습니다.";
          }
          if (out.ext !== "mp4") {
            note += " 이 브라우저는 MP4를 만들 수 없어 WebM으로 저장했습니다.";
          }
          toast(note, 7000);

          el.saveModal.hidden = true;
          state.pendingMission = null;
          resetVideoProgress();
        }).catch(function (saveErr) {
          // 영상은 만들어졌으니 버리지 않는다. 직접 저장할 링크를 띄운다.
          state.videoRendering = false;
          setSaveButtonsDisabled(false);
          el.saveVideoProgress.hidden = true;
          showSaveError(
            "영상은 만들었지만 파일로 저장하지 못했습니다. " +
              (saveErr && saveErr.message ? saveErr.message : "")
          );
          showManualSaveLink(out.blob, fileName);
        });
      })
      .catch(function (err) {
        // 기록은 이미 저장되어 있으므로 창은 열어 두고 원인만 알린다.
        state.videoRendering = false;
        setSaveButtonsDisabled(false);
        el.saveVideoProgress.hidden = true;
        showSaveError(
          "기록은 저장했지만 영상을 만들지 못했습니다. " + (err && err.message ? err.message : "")
        );
      });
  }

  /**
   * Blob 을 기기에 파일로 저장한다.
   *
   * 안드로이드 앱의 WebView 는 a[download] 와 blob: 저장을 처리하지 않는다.
   * 그래서 네이티브 다리가 있으면 그쪽으로 넘기고, 없으면 보통의 내려받기를 쓴다.
   *
   * @returns {Promise<string>} "android" 또는 "browser"
   */
  function saveFile(blob, fileName, mime) {
    var bridge = window.AndroidBridge;
    var canNative = false;
    try {
      canNative = !!(bridge && typeof bridge.beginFile === "function" && bridge.canSaveFile());
    } catch (e) {
      canNative = false;
    }

    if (canNative) {
      return saveFileViaAndroid(blob, fileName, mime, bridge).then(function () {
        return "android";
      });
    }

    return new Promise(function (resolve, reject) {
      try {
        downloadBlob(blob, fileName);
        resolve("browser");
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 네이티브로 파일을 넘긴다.
   *
   * JavascriptInterface 는 문자열만 오갈 수 있어 base64 로 바꿔 보낸다.
   * 영상은 10MB를 넘길 수 있으므로 한 번에 넘기지 않고 조각으로 나눈다.
   * 거대한 문자열 하나를 만들면 기기에서 메모리가 터진다.
   */
  function saveFileViaAndroid(blob, fileName, mime, bridge) {
    var CHUNK = 512 * 1024; // 원본 기준. base64 로는 약 683KB.

    if (!bridge.beginFile(fileName, mime || blob.type || "application/octet-stream")) {
      return Promise.reject(new Error("기기가 저장을 시작하지 못했습니다."));
    }

    var offset = 0;

    function sendNext() {
      if (offset >= blob.size) {
        var saved = bridge.endFile();
        if (!saved) return Promise.reject(new Error("기기가 파일을 마무리하지 못했습니다."));
        return Promise.resolve();
      }

      var slice = blob.slice(offset, Math.min(offset + CHUNK, blob.size));
      offset += CHUNK;

      return blobToBase64(slice).then(function (b64) {
        if (!bridge.appendFile(b64)) {
          bridge.abortFile();
          throw new Error("기기가 조각을 받지 못했습니다.");
        }
        el.saveVideoStatus.textContent =
          "파일로 저장하는 중… " + Math.min(100, Math.round((offset / blob.size) * 100)) + "%";
        return sendNext();
      });
    }

    return sendNext().catch(function (e) {
      try {
        bridge.abortFile();
      } catch (ignored) {
        /* 이미 정리된 경우 */
      }
      throw e;
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        // data:...;base64,XXXX 에서 뒤쪽만 쓴다.
        var s = String(reader.result);
        var comma = s.indexOf(",");
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      reader.onerror = function () {
        reject(new Error("파일 조각을 읽지 못했습니다."));
      };
      reader.readAsDataURL(blob);
    });
  }

  function downloadMission(mission) {
    var payload = {
      mission: {
        name: mission.name,
        team: mission.teamName,
        startedAt: new Date(mission.startedAt).toISOString(),
        endedAt: new Date(mission.endedAt).toISOString(),
        summary: RtlocMission.summarize(mission)
      },
      geojson: RtlocMission.toGeoJson(mission)
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    // 안드로이드 앱에서도 실제로 파일이 남도록 같은 저장 경로를 쓴다.
    saveFile(blob, safeFileName(mission.name) + ".json", "application/json")
      .then(function (how) {
        toast(
          how === "android"
            ? "임무 파일을 기기의 다운로드 폴더에 저장했습니다."
            : "임무 파일을 내려받았습니다."
        );
      })
      .catch(function (e) {
        toast("임무 파일을 저장하지 못했습니다. " + (e && e.message ? e.message : ""), 6000);
      });
  }

  /** Blob 을 파일로 내려받는다. 임시 URL 은 잠시 뒤 회수한다. */
  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function discardSave() {
    el.saveModal.hidden = true;
    state.pendingMission = null;
    resetVideoProgress();
    toast("이번 임무 기록을 저장하지 않았습니다.");
  }

  // ---------- 저장된 임무 목록 ----------
  function openHistory() {
    var missions = RtlocMission.storage.list(state.topic);
    el.historyList.innerHTML = "";
    el.historyEmpty.hidden = missions.length > 0;

    missions.forEach(function (mission) {
      var summary = RtlocMission.summarize(mission);
      var li = document.createElement("li");
      li.className = "history-item";

      var title = document.createElement("div");
      title.className = "history-title";
      title.textContent = mission.name || "이름 없는 임무";

      var meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent =
        formatDateTime(new Date(mission.startedAt)) +
        " · " +
        formatDuration(summary.durationMs) +
        " · 대원 " +
        summary.memberCount +
        "명 · " +
        formatDistance(summary.totalDistance);

      var actions = document.createElement("div");
      actions.className = "history-actions";

      actions.appendChild(
        makeSmallButton("지도에 보기", function () {
          showMissionOnMap(mission);
          el.historyModal.hidden = true;
        })
      );
      actions.appendChild(
        makeSmallButton("내려받기", function () {
          downloadMission(mission);
        })
      );
      actions.appendChild(
        makeSmallButton("삭제", function () {
          if (!window.confirm("'" + (mission.name || "이 임무") + "' 기록을 삭제할까요?")) return;
          RtlocMission.storage.remove(state.topic, mission.id);
          openHistory();
          toast("기록을 삭제했습니다.");
        }, "danger")
      );

      li.appendChild(title);
      li.appendChild(meta);
      li.appendChild(actions);
      el.historyList.appendChild(li);
    });

    el.historyModal.hidden = false;
  }

  function makeSmallButton(label, onClick, extraClass) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost small" + (extraClass ? " " + extraClass : "");
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function clearHistoryLayer() {
    if (!state.historyLayer) return;
    state.historyLayer.remove();
    state.historyLayer = null;
  }

  /** 저장된 임무의 경로를 지도에 겹쳐 보여준다. */
  function showMissionOnMap(mission) {
    clearHistoryLayer();

    var layer = RtlocMap.group();
    mission.tracks.forEach(function (track, index) {
      if (track.points.length < 1) return;
      var color = track.color || PALETTE[index % PALETTE.length];
      var latlngs = track.points.map(function (p) {
        return [p[0], p[1]];
      });

      RtlocMap.polyline({ path: latlngs, color: color, weight: 4, opacity: 0.9 }).addTo(layer);

      // 시작·종료 지점. 툴팁이 없는 API 라서 이름을 점 옆에 직접 그린다.
      endpointMarker(latlngs[0], color, track.name + " 시작", false).addTo(layer);
      endpointMarker(latlngs[latlngs.length - 1], color, track.name + " 종료", true).addTo(layer);
    });

    layer.addTo(state.map);
    state.historyLayer = layer;

    var bounds = RtlocMission.boundsOf(mission);
    if (bounds) {
      setFollow(false);
      state.map.fitBounds(bounds, 40);
    }
    toast("'" + (mission.name || "임무") + "' 경로를 지도에 표시했습니다. 임무를 시작하면 사라집니다.", 5000);
  }

  /**
   * 저장된 임무의 시작/종료 지점 표식.
   * @param {number[]} pair [위도, 경도]
   * @param {string} color 대원 색
   * @param {string} label 점 옆에 붙일 글자
   * @param {boolean} filled 종료 지점은 색을 채워 구분한다
   */
  function endpointMarker(pair, color, label, filled) {
    return RtlocMap.marker({
      position: pair,
      html:
        '<div class="endpoint">' +
        '<span class="endpoint-dot' +
        (filled ? " endpoint-dot--filled" : "") +
        '" style="border-color:' +
        color +
        (filled ? ";background:" + color : "") +
        '"></span>' +
        '<span class="endpoint-label">' +
        escapeHtml(label) +
        "</span></div>",
      anchor: [7, 7],
      zIndex: 400
    });
  }

  // ---------- 지도 유형 ----------

  /**
   * 일반 / 지형 / 등고선 / 위성 전환 버튼을 붙인다.
   *
   * 등고선은 네이버가 제공하지 않아 OpenTopoMap 을 쓴다(naver-map.js 참고).
   * 고른 유형은 기기에 기억해 다음 접속에도 유지한다.
   */
  function setupMapTypes() {
    var available = state.map.mapTypes();
    var buttons = Array.prototype.slice.call(document.querySelectorAll(".maptype-btn"));

    buttons.forEach(function (btn) {
      var id = btn.getAttribute("data-maptype");

      // 이 기기에서 쓸 수 없는 유형은 버튼을 감춘다.
      if (available.indexOf(id) === -1) {
        btn.hidden = true;
        return;
      }

      btn.addEventListener("click", function () {
        applyMapType(id, true);
      });
    });

    var saved = null;
    try {
      saved = localStorage.getItem(MAPTYPE_KEY);
    } catch (e) {
      /* 저장소를 못 쓰는 기기 */
    }
    applyMapType(available.indexOf(saved) >= 0 ? saved : "normal", false);
  }

  function applyMapType(id, remember) {
    var applied = state.map.setMapType(id);

    document.querySelectorAll(".maptype-btn").forEach(function (btn) {
      var on = btn.getAttribute("data-maptype") === applied;
      btn.setAttribute("aria-pressed", String(on));
      btn.classList.toggle("active", on);
    });

    if (remember) {
      try {
        localStorage.setItem(MAPTYPE_KEY, applied);
      } catch (e) {
        /* 저장 못해도 이번 세션에는 적용된다 */
      }
      if (applied === "contour") {
        toast("등고선 지도로 바꿨습니다. 확대는 17단계까지 됩니다.", 5000);
      }
    }
  }

  /** 지도 스크립트를 못 받았을 때. 원인이 대개 도메인 등록이라 그걸 짚어 준다. */
  function showMapLoadError() {
    var box = document.createElement("div");
    box.className = "map-error";
    box.innerHTML =
      "<strong>지도를 불러오지 못했습니다.</strong>" +
      "<span>네이버 지도 API 키에 이 사이트 주소가 등록되어 있는지 확인해 주세요. " +
      "네트워크가 막힌 경우에도 이 안내가 나옵니다. 지도 외의 기능은 그대로 쓸 수 있습니다.</span>";
    var container = document.getElementById("map");
    if (container) container.appendChild(box);
    toast("지도를 불러오지 못했습니다. 메시지와 메모 목록은 계속 쓸 수 있습니다.", 8000);
  }

  function setFollow(on) {
    state.follow = on;
    el.followBtn.setAttribute("aria-pressed", String(on));
    el.followBtn.textContent = "따라가기: " + (on ? "켜짐" : "꺼짐");
  }

  function setStatus(kind, text) {
    el.connStatus.className = "status status--" + kind;
    el.connStatus.textContent = text;
  }

  // ---------- 팀 메시지 ----------
  function setupChat() {
    syncAlertButton();

    el.chatBtn.addEventListener("click", openChat);
    el.chatClose.addEventListener("click", function () {
      el.chatModal.hidden = true;
    });

    el.alertBtn.addEventListener("click", function () {
      var on = RtlocAlert.setEnabled(!RtlocAlert.isEnabled());
      syncAlertButton();
      if (on) {
        // 켰을 때는 바로 한 번 울려서 확인시켜 준다.
        RtlocAlert.notifyMessage();
        toast("알람을 켰습니다. 메시지가 오면 진동과 소리로 알립니다.", 4000);
      } else {
        toast("알람을 껐습니다. 메시지는 화면 표시로만 알립니다.", 4000);
      }
    });

    el.chatForm.addEventListener("submit", function (event) {
      event.preventDefault();
      sendChat();
    });

    // 엔터로 보내고, Shift+엔터는 줄바꿈으로 둔다.
    el.chatInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChat();
      }
    });

    el.chatClear.addEventListener("click", function () {
      if (!window.confirm("이 기기에 저장된 메시지 기록을 지울까요?")) return;
      RtlocChat.clear(state.topic);
      renderChat();
      toast("메시지 기록을 지웠습니다.");
    });

    renderChat();
  }

  function syncAlertButton() {
    var on = RtlocAlert.isEnabled();
    el.alertBtn.setAttribute("aria-pressed", String(on));
    el.alertBtn.classList.toggle("on", on);
    el.alertBtn.textContent = "알람: " + (on ? "켜짐" : "꺼짐");
  }

  function openChat() {
    el.chatModal.hidden = false;
    state.unreadCount = 0;
    syncUnreadBadge();
    renderChat();
    el.chatInput.focus();
  }

  function sendChat() {
    var message = RtlocChat.build(el.chatInput.value, state.clientId, state.callsign);
    if (!message) return;

    if (!state.client || !state.client.connected) {
      toast("연결이 끊겨 메시지를 보낼 수 없습니다. 연결 상태를 확인해 주세요.", 5000);
      return;
    }

    publish({
      type: "chat",
      id: state.clientId,
      msgId: message.id,
      senderId: message.senderId,
      senderName: message.senderName,
      text: message.text,
      ts: message.ts
    });

    RtlocChat.append(state.topic, message);
    el.chatInput.value = "";
    renderChat();
  }

  function receiveChat(msg) {
    var message = RtlocChat.sanitize({
      id: msg.msgId,
      text: msg.text,
      senderId: msg.senderId || msg.id,
      senderName: msg.senderName,
      ts: msg.ts
    });
    if (!message) return;

    var isNew = RtlocChat.append(state.topic, message);
    if (!isNew) return; // 중복 수신

    if (RtlocAlert.isEnabled()) {
      // 진동은 네이티브를 우선한다. 브라우저의 navigator.vibrate 는
      // 기기·정책에 따라 조용히 무시되는 경우가 많다.
      var nativeVibrated = false;
      if (window.AndroidBridge && typeof window.AndroidBridge.notifyMessage === "function") {
        try {
          window.AndroidBridge.notifyMessage(message.senderName, message.text);
          nativeVibrated = true;
        } catch (e) {
          /* 구버전 앱에는 이 기능이 없다 */
        }
      }

      if (nativeVibrated) {
        RtlocAlert.beep(); // 소리만 웹에서 낸다
      } else {
        RtlocAlert.notifyMessage(); // 진동 + 소리 모두 웹에서 시도
        // 앱이 아닌 브라우저에서, 화면을 보고 있지 않을 때는 시스템 팝업을 띄운다.
        RtlocAlert.showSystemNotification(message.senderName, message.text);
      }
    }

    if (el.chatModal.hidden) {
      state.unreadCount += 1;
      syncUnreadBadge();
      toast(message.senderName + ": " + truncate(message.text, 40), 6000);
    }
    renderChat();
  }

  function syncUnreadBadge() {
    if (state.unreadCount > 0) {
      el.chatUnread.hidden = false;
      el.chatUnread.textContent = String(state.unreadCount);
      el.chatBtn.classList.add("has-unread");
    } else {
      el.chatUnread.hidden = true;
      el.chatBtn.classList.remove("has-unread");
    }
  }

  function renderChat() {
    var messages = RtlocChat.list(state.topic);
    el.chatEmpty.hidden = messages.length > 0;
    el.chatList.innerHTML = "";

    messages.forEach(function (message) {
      var li = document.createElement("li");
      var mine = message.senderId === state.clientId;
      li.className = "chat-item" + (mine ? " chat-item--mine" : "");

      var head = document.createElement("div");
      head.className = "chat-head";
      head.textContent =
        (mine ? "나" : message.senderName) + " · " + formatClock(new Date(message.ts));

      var body = document.createElement("div");
      body.className = "chat-text";
      body.textContent = message.text;

      li.appendChild(head);
      li.appendChild(body);
      el.chatList.appendChild(li);
    });

    // 항상 최신 메시지가 보이도록 맨 아래로 내린다.
    el.chatList.scrollTop = el.chatList.scrollHeight;
  }

  function formatClock(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  // ---------- 화면 꺼짐 상태 추적 (안드로이드 앱 전용) ----------
  /**
   * 브라우저는 화면이 꺼지면 위치 갱신을 멈춘다. 안드로이드 앱으로 실행한 경우에만
   * 네이티브 포그라운드 서비스가 대신 위치를 올릴 수 있다.
   * 그 서비스는 웹과 같은 대원 id 로 발행하므로 팀원 지도에서는 끊김 없이 이어진다.
   */
  function setupBackgroundTracking() {
    var bridge = window.AndroidBridge;
    if (!bridge || typeof bridge.startTracking !== "function") return; // 웹 브라우저

    // 자체 브로커의 아이디·암호를 서비스에도 알려 준다. 없으면 넘어간다.
    sendBrokerAuth(bridge);

    // 앱에 들어오면 메시지 수신 서비스를 곧바로 켠다.
    // 이게 켜져 있어야 앱을 보고 있지 않을 때도 메시지 팝업이 뜬다.
    // 위치 권한과 무관하게 동작한다.
    if (typeof bridge.startMessaging === "function") {
      try {
        bridge.startMessaging(
          state.teamName,
          state.secret || "",
          state.callsign,
          state.clientId,
          el.broker.value.trim()
        );
      } catch (e) {
        /* 구버전 앱 */
      }
    }

    el.bgBtn.hidden = false;
    syncBackgroundButton();
    setupUpdateButton(bridge);

    el.bgBtn.addEventListener("click", function () {
      var on = isBackgroundTracking();

      if (on) {
        bridge.stopTracking();
        toast("화면 꺼짐 추적을 껐습니다. 이제 화면이 꺼지면 내 위치가 멈춥니다.", 5000);
      } else {
        sendBrokerAuth(bridge);
        bridge.startTracking(
          state.teamName,
          state.secret || "",
          state.callsign,
          state.clientId,
          el.broker.value.trim()
        );
        toast(
          "화면 꺼짐 추적을 켰습니다. 위치 권한을 '항상 허용'으로 요청하면 승인해 주세요.",
          7000
        );
      }

      // 권한 창을 거친 뒤 상태가 바뀔 수 있어 잠시 후 다시 확인한다.
      setTimeout(syncBackgroundButton, 1500);
      setTimeout(syncBackgroundButton, 5000);
    });

    setInterval(syncBackgroundButton, 5000);
  }

  /** 자체 브로커 자격을 네이티브 서비스에 넘긴다(구버전 앱에서는 조용히 넘어간다). */
  function sendBrokerAuth(bridge) {
    if (!state.brokerUser) return;
    if (typeof bridge.setBrokerAuth !== "function") return;
    try {
      bridge.setBrokerAuth(state.brokerUser, state.brokerPass || "");
    } catch (e) {
      /* 구버전 앱 */
    }
  }

  /**
   * 앱은 켤 때마다 새 버전을 스스로 확인한다(6시간에 한 번).
   * 이 버튼은 기다리지 않고 지금 확인하고 싶을 때 쓴다.
   */
  function setupUpdateButton(bridge) {
    if (typeof bridge.checkUpdate !== "function") return; // 구버전 앱

    var version = "";
    try {
      if (typeof bridge.appVersion === "function") version = bridge.appVersion();
    } catch (e) {
      /* 구버전 앱 */
    }

    el.updateBtn.hidden = false;
    el.updateBtn.textContent = version ? "업데이트 확인 (v" + version + ")" : "업데이트 확인";

    el.updateBtn.addEventListener("click", function () {
      try {
        bridge.checkUpdate();
      } catch (e) {
        toast("업데이트를 확인할 수 없습니다.", 5000);
      }
    });
  }

  function isBackgroundTracking() {
    var bridge = window.AndroidBridge;
    try {
      return !!(bridge && bridge.isTracking && bridge.isTracking());
    } catch (e) {
      return false;
    }
  }

  function syncBackgroundButton() {
    if (el.bgBtn.hidden) return;
    var on = isBackgroundTracking();
    el.bgBtn.setAttribute("aria-pressed", String(on));
    el.bgBtn.classList.toggle("on", on);
    el.bgBtn.textContent = "화면 꺼짐 추적: " + (on ? "켜짐" : "끄기");
  }

  // ---------- 화면 꺼짐 방지 ----------
  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    navigator.wakeLock
      .request("screen")
      .then(function (lock) {
        state.wakeLock = lock;
        lock.addEventListener("release", function () {
          state.wakeLock = null;
        });
      })
      .catch(function () {
        // 배터리 절약 모드 등에서 거부될 수 있다. 필수 기능은 아니다.
      });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !state.wakeLock && state.client) {
        requestWakeLock();
      }
    });
  }

  // ---------- MQTT ----------
  function connect() {
    var url = state.brokers[state.brokerIndex];
    setStatus("connecting", "연결 중…");

    var options = {
      clientId: "rtloc-" + state.clientId,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      keepalive: 30
    };
    // 자체 브로커는 아이디·암호를 요구하는 경우가 많다.
    if (state.brokerUser) {
      options.username = state.brokerUser;
      options.password = state.brokerPass;
    }
    if (state.willPayload) {
      options.will = { topic: state.topic, payload: state.willPayload, qos: 0, retain: false };
    }

    var client = mqtt.connect(url, options);
    state.client = client;

    var settled = false;

    client.on("connect", function () {
      settled = true;
      setStatus("online", "연결됨");

      client.subscribe(state.topic, { qos: 0 }, function (err) {
        if (err) {
          setStatus("offline", "구독 실패");
          toast("팀 채널 구독에 실패했습니다.");
          return;
        }
        publish({ type: "hello", id: state.clientId, name: state.callsign });
        publishPosition(true);
        // 내가 가진 첨부 중 보관함에 없는 것을 올린다. 시작 직후 채널을 비워 두려고 조금 기다린다.
        setTimeout(backfillVault, 4000);
      });
    });

    client.on("reconnect", function () {
      setStatus("connecting", "재연결 중…");
    });

    client.on("close", function () {
      if (settled) setStatus("offline", "연결 끊김");
    });

    client.on("error", function () {
      if (settled) return;
      // 최초 연결 실패면 다음 브로커로 넘어간다.
      client.end(true);
      if (state.brokerIndex < state.brokers.length - 1) {
        state.brokerIndex += 1;
        toast("브로커 전환: " + hostOf(state.brokers[state.brokerIndex]));
        connect();
      } else {
        setStatus("offline", "연결 실패");
        toast("모든 브로커에 연결하지 못했습니다. 네트워크를 확인해 주세요.", 6000);
      }
    });

    client.on("message", function (topic, payload) {
      var text = payload.toString();

      if (topic === state.topic) {
        decryptMessage(text)
          .then(handleMessage)
          .catch(function () {
            // 팀 암호가 다른 사람의 메시지. 조용히 버린다.
          });
        return;
      }

      // 첨부 보관함에서 온 조각.
      if (isVaultTopic(topic)) {
        if (!text) return; // 지워진 조각
        decryptMessage(text)
          .then(handleVaultChunk)
          .catch(function () {
            // 암호가 다르면 읽을 수 없다.
          });
      }
    });

    if (!state.sweepTimer) state.sweepTimer = setInterval(sweep, 5000);
    if (!state.heartbeatTimer) {
      state.heartbeatTimer = setInterval(function () {
        publishPosition(true);
      }, HEARTBEAT_INTERVAL);
    }

    window.addEventListener("pagehide", sendLeave);
    window.addEventListener("beforeunload", sendLeave);
  }

  function publish(obj) {
    if (!state.client || !state.client.connected) return;
    var client = state.client;
    encryptMessage(obj)
      .then(function (envelope) {
        if (client.connected) client.publish(state.topic, envelope, { qos: 0, retain: false });
      })
      .catch(function () {
        // 암호화 실패 시에는 전송하지 않는다. 평문으로 새어나가면 안 된다.
      });
  }

  function sendLeave() {
    publish({ type: "leave", id: state.clientId });
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (e) {
      return url;
    }
  }

  // ---------- 메시지 처리 ----------
  function handleMessage(msg) {
    if (!msg || !msg.id || msg.id === state.clientId) return;

    if (msg.type === "leave") {
      removeMember(msg.id);
      renderMembers();
      return;
    }

    if (msg.type === "hello") {
      publishPosition(true);
      // 임무 중이라면 늦게 들어온 대원도 같은 임무를 기록하게 알려준다.
      if (state.recorder) {
        publish({
          type: "mission",
          action: "start",
          id: state.clientId,
          name: state.callsign,
          missionId: state.recorder.missionId,
          at: state.recorder.startedAt
        });
      }
      // 내가 작성한 메모를 새로 들어온 대원에게도 알려준다.
      shareOwnMemos();
      return;
    }

    if (msg.type === "chat") {
      receiveChat(msg);
      return;
    }

    if (msg.type === "media") {
      if (msg.action === "list" && msg.memoId) {
        serveManifestRequest(msg);
      } else if (msg.action === "listed" && msg.memoId) {
        applyManifest(msg);
      } else if (msg.action === "req" && msg.memoId && msg.mediaId) {
        serveMediaRequest(msg);
      } else if (msg.action === "chunk" && msg.chunk && msg.mediaId) {
        // 누가 이 첨부를 보내고 있는지 기록해 둔다(중복 전송 방지용).
        state.chunkSeen[msg.mediaId] = Date.now();
        // 나에게 온 조각만 조립한다(다른 대원에게 가는 조각은 건너뛴다).
        if (msg.to && msg.to !== state.clientId) return;
        state.mediaOwnerMemo[msg.mediaId] = msg.memoId;
        ensureAssembler().accept(msg.mediaId, msg.chunk);
      }
      return;
    }

    if (msg.type === "memo") {
      if (msg.action === "add" && msg.memo && isFiniteNumber(msg.memo.lat) && isFiniteNumber(msg.memo.lng)) {
        // 이미 가진 메모라면 본문/첨부를 덮어쓰지 않는다.
        // 다만 첨부 목록은 병합한다. 예전 버전에서 받아 목록이 비어 있는 메모를 되살리기 위함이다.
        if (state.memos[msg.memo.id]) {
          RtlocMemo.get(msg.memo.id).then(function (stored) {
            if (!stored || !stored.remote) return;
            if (!RtlocMemo.mergeManifest(stored, msg.memo.manifest)) return;
            RtlocMemo.put(stored).then(function () {
              state.memos[stored.id].memo = stored;
              if (state.memoDetailId === stored.id && !el.memoDetailModal.hidden) {
                renderDetailMedia(stored);
                requestMissingMedia(stored);
              }
              queueAutoFetch(stored);
            });
          });
          return;
        }
        var incoming = RtlocMemo.fromWire(msg.memo, state.topic);
        RtlocMemo.put(incoming)
          .then(function () {
            addMemoMarker(incoming);
            updateMemoCount();
            toast((incoming.author || "대원") + " 님이 메모를 남겼습니다.", 5000);
            // 사진은 열어 보기 전에 미리 받아 둔다. 그러면 나중에 아무도 접속해
            // 있지 않아도 이 기기에서 바로 볼 수 있다.
            queueAutoFetch(incoming);
          })
          .catch(function () {
            // 저장에 실패해도 지도에는 띄운다.
            addMemoMarker(incoming);
            updateMemoCount();
          });
      } else if (msg.action === "remove" && msg.memoId) {
        var entry = state.memos[msg.memoId];
        if (entry && entry.memo.remote) {
          RtlocMemo.remove(msg.memoId);
          removeMemoMarker(msg.memoId);
          updateMemoCount();
        }
      }
      return;
    }

    if (msg.type === "mission") {
      if (msg.action === "start") {
        // 이미 같은 임무를 기록 중이면 무시한다(중복 알림 방지).
        if (state.recorder && state.recorder.missionId === msg.missionId) return;
        if (state.recorder) return;
        startMission({ missionId: msg.missionId, at: msg.at || Date.now(), name: msg.name }, false);
      } else if (msg.action === "end") {
        if (!state.recorder) return;
        toast((msg.name || "대원") + " 님이 임무를 종료했습니다.", 5000);
        endMission(false);
      }
      return;
    }

    if (msg.type === "pos" && isFiniteNumber(msg.lat) && isFiniteNumber(msg.lng)) {
      upsertMember({
        id: msg.id,
        name: typeof msg.name === "string" && msg.name ? msg.name : "대원-" + msg.id.slice(0, 4),
        lat: msg.lat,
        lng: msg.lng,
        accuracy: isFiniteNumber(msg.acc) ? msg.acc : null,
        heading: isFiniteNumber(msg.hdg) ? msg.hdg : null,
        speed: isFiniteNumber(msg.spd) ? msg.spd : null,
        altitude: isFiniteNumber(msg.alt) ? msg.alt : null,
        altitudeAccuracy: isFiniteNumber(msg.altAcc) ? msg.altAcc : null,
        updatedAt: Date.now()
      });
      renderMembers();
    }
  }

  // ---------- 위치 추적 ----------
  function startTracking() {
    state.watchId = navigator.geolocation.watchPosition(
      function (position) {
        state.lastPosition = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          heading: position.coords.heading,
          speed: position.coords.speed,
          // 고도는 GPS 가 잡혀야 나온다. 실내나 와이파이 측위에서는 null 이다.
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy
        };

        upsertMember({
          id: state.clientId,
          name: state.callsign,
          lat: state.lastPosition.lat,
          lng: state.lastPosition.lng,
          accuracy: state.lastPosition.accuracy,
          heading: state.lastPosition.heading,
          speed: state.lastPosition.speed,
          altitude: state.lastPosition.altitude,
          altitudeAccuracy: state.lastPosition.altitudeAccuracy,
          updatedAt: Date.now(),
          isMe: true
        });
        renderMembers();

        if (state.follow) {
          var zoom = state.map.getZoom() < 15 ? 16 : state.map.getZoom();
          state.map.setView([state.lastPosition.lat, state.lastPosition.lng], zoom);
        }

        publishPosition(false);
      },
      function (error) {
        var messages = {
          1: "위치 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요.",
          2: "현재 위치를 확인할 수 없습니다. GPS/네트워크 상태를 확인해 주세요.",
          3: "위치 확인이 시간 초과되었습니다."
        };
        toast(messages[error.code] || "위치 오류: " + error.message, 6000);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  function publishPosition(force) {
    if (!state.lastPosition) return;
    var now = Date.now();
    if (!force && now - state.lastPublishedAt < PUBLISH_MIN_INTERVAL) return;
    state.lastPublishedAt = now;

    publish({
      type: "pos",
      id: state.clientId,
      name: state.callsign,
      lat: round6(state.lastPosition.lat),
      lng: round6(state.lastPosition.lng),
      acc: state.lastPosition.accuracy != null ? Math.round(state.lastPosition.accuracy) : null,
      hdg: isFiniteNumber(state.lastPosition.heading) ? Math.round(state.lastPosition.heading) : null,
      spd: isFiniteNumber(state.lastPosition.speed) ? state.lastPosition.speed : null,
      // 고도(m). GPS 가 안 잡히면 null 로 나가고 받는 쪽은 표시를 생략한다.
      alt: isFiniteNumber(state.lastPosition.altitude) ? Math.round(state.lastPosition.altitude) : null,
      altAcc: isFiniteNumber(state.lastPosition.altitudeAccuracy)
        ? Math.round(state.lastPosition.altitudeAccuracy)
        : null,
      ts: now
    });
  }

  // ---------- 색상 배분 ----------
  /**
   * 팀 안에서 색이 겹치지 않게 배분한다.
   *
   * id 정렬 순서로 순회하며 각자의 선호 색(id 해시)부터 시작해 비어 있는 첫 색을 집는다.
   * 같은 대원 집합을 보고 있는 모든 기기가 같은 결과를 얻으므로, 내 화면의 색과
   * 팀원 화면의 색이 일치한다. 팔레트를 초과하면 그때부터만 색이 재사용된다.
   */
  function assignColors() {
    var colors = RtlocPalette.assign(Object.keys(state.members));
    var changed = [];

    Object.keys(colors).forEach(function (id) {
      var member = state.members[id];
      if (member && member.color !== colors[id]) {
        member.color = colors[id];
        changed.push(member);
      }
    });

    changed.forEach(function (member) {
      member.marker.setHtml(makeIcon(member));
      member.circle.setColor(member.color);
      if (member.trail) member.trail.setColor(member.color);
    });

    return changed.length > 0;
  }

  // ---------- 마커와 경로 ----------
  function upsertMember(data) {
    var member = state.members[data.id];
    var isNew = !member;

    if (isNew) {
      member = state.members[data.id] = {
        id: data.id,
        color: RtlocPalette.preferredColor(data.id),
        trail: null,
        stale: false,
        altitude: null,
        altitudeAccuracy: null,
        marker: null,
        circle: null
      };
      member.circle = RtlocMap.circle({
        center: [data.lat, data.lng],
        radius: data.accuracy || 0,
        color: member.color
      });
      // 이름은 마커 안에 함께 그린다. 네이버 API 에는 툴팁이 없고,
      // 휴대폰에는 호버가 없어서 툴팁은 원래도 보이지 않았다.
      member.marker = RtlocMap.marker({
        position: [data.lat, data.lng],
        html: makeIcon({
          name: data.name,
          color: member.color,
          isMe: data.isMe,
          stale: false,
          altitude: data.altitude
        }),
        anchor: [13, 13],
        zIndex: data.isMe ? 300 : 200
      });
      member.circle.addTo(state.map);
      member.marker.addTo(state.map);
      if (!data.isMe) toast(data.name + " 님이 팀 채널에 나타났습니다.");
    }

    var nameChanged = member.name !== data.name;
    var altChanged = displayAltitude(member.altitude) !== displayAltitude(data.altitude);
    Object.assign(member, {
      name: data.name,
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy,
      heading: data.heading,
      speed: data.speed,
      altitude: data.altitude == null ? null : data.altitude,
      altitudeAccuracy: data.altitudeAccuracy == null ? null : data.altitudeAccuracy,
      updatedAt: data.updatedAt,
      isMe: !!data.isMe
    });

    member.marker.setPosition([data.lat, data.lng]);
    member.circle.setCenter([data.lat, data.lng]);
    member.circle.setRadius(data.accuracy || 0);

    // 위치가 갱신되면 다시 또렷하게 보인다.
    var wasStale = member.stale;
    member.stale = false;

    // 새 대원이 들어오면 팀 전체 색을 다시 배분한다(중복 방지).
    var recolored = isNew ? assignColors() : false;
    // 고도가 바뀌면 이름표 위 숫자도 같이 갱신해야 한다.
    if (nameChanged || altChanged || wasStale || (isNew && !recolored)) {
      member.marker.setHtml(makeIcon(member));
      member.circle.setColor(member.color);
    }

    // 임무 중이면 이동 경로를 기록하고 선을 늘린다.
    if (state.recorder) {
      var added = state.recorder.addPoint(
        member.id,
        member.name,
        member.lat,
        member.lng,
        member.updatedAt
      );
      if (added) drawTrail(member);
    }
  }

  /** 기록된 경로를 지도 위 선으로 반영한다. */
  function drawTrail(member) {
    if (!state.recorder) return;
    var track = state.recorder.trackOf(member.id);
    if (!track || track.points.length < 2) return;

    var latlngs = track.points.map(function (p) {
      return [p[0], p[1]];
    });

    if (!member.trail) {
      member.trail = RtlocMap.polyline({
        path: latlngs,
        color: member.color,
        weight: 4,
        opacity: 0.85
      }).addTo(state.map);
    } else {
      member.trail.setPath(latlngs);
    }
  }

  function removeMember(id) {
    var member = state.members[id];
    if (!member) return;
    member.marker.remove();
    member.circle.remove();
    // 경로선은 남겨 둔다. 임무 중 이탈한 대원의 이동 흔적도 기록의 일부다.
    delete state.members[id];
    toast(member.name + " 님이 나갔습니다.");
  }

  /**
   * 표시용 고도 문자열. 값이 없으면 null.
   *
   * 기기가 주는 값은 WGS84 타원체 기준이라 해수면 기준 표고와 다르다.
   * 한반도에서는 대략 20~25m 정도 높게 나온다. 대원끼리의 상대 고도차나
   * 오르내림 추세를 보는 데는 문제가 없지만, 지도의 표고와는 차이가 난다.
   */
  function displayAltitude(altitude) {
    if (!isFiniteNumber(altitude)) return null;
    return Math.round(altitude) + "m";
  }

  /**
   * 대원 마커의 HTML.
   * 색 원 안에 이름 첫 글자, 오른쪽에 고도(위)와 이름(아래)을 쌓는다.
   * @param {{name: string, color: string, isMe: boolean, stale: boolean, altitude: number}} member
   */
  function makeIcon(member) {
    var name = String(member.name || "");
    var initial = escapeHtml(name.trim().charAt(0) || "?");
    var alt = displayAltitude(member.altitude);

    return (
      '<div class="pin-wrap' +
      (member.stale ? " pin-wrap--stale" : "") +
      '">' +
      '<span class="pin' +
      (member.isMe ? " pin--me" : "") +
      '" style="background:' +
      member.color +
      '">' +
      initial +
      "</span>" +
      '<span class="pin-labels">' +
      (alt ? '<span class="pin-alt">' + escapeHtml(alt) + "</span>" : "") +
      '<span class="pin-name">' +
      escapeHtml(name) +
      "</span>" +
      "</span>" +
      "</div>"
    );
  }

  function sweep() {
    var now = Date.now();
    Object.keys(state.members).forEach(function (id) {
      if (id === state.clientId) return;
      var member = state.members[id];
      var age = now - member.updatedAt;
      if (age > DROP_AFTER) {
        removeMember(id);
      } else if (age > STALE_AFTER && !member.stale) {
        // 마커에 setOpacity 가 없다. 아이콘을 다시 그려 흐리게 만든다.
        member.stale = true;
        member.marker.setHtml(makeIcon(member));
      }
    });
    renderMembers();
  }

  // ---------- 사이드바 ----------
  function renderMembers() {
    var now = Date.now();
    var list = Object.keys(state.members).map(function (id) {
      return state.members[id];
    });

    list.sort(function (a, b) {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      return a.name.localeCompare(b.name, "ko");
    });

    el.memberCount.textContent = String(list.length);
    el.emptyHint.hidden = list.length > 1;
    el.memberList.innerHTML = "";

    list.forEach(function (member) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "member" +
        (member.isMe ? " is-me" : "") +
        (now - member.updatedAt > STALE_AFTER ? " is-stale" : "");
      btn.style.setProperty("--dot", member.color);

      var name = document.createElement("div");
      name.className = "name";
      name.textContent = member.name;

      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = metaText(member, now);

      btn.appendChild(name);
      btn.appendChild(meta);
      btn.addEventListener("click", function () {
        setFollow(false);
        state.map.setView([member.lat, member.lng], Math.max(state.map.getZoom(), 16));
      });

      li.appendChild(btn);
      el.memberList.appendChild(li);
    });
  }

  function metaText(member, now) {
    var parts = [];
    parts.push(member.lat.toFixed(5) + ", " + member.lng.toFixed(5));
    var alt = displayAltitude(member.altitude);
    if (alt) {
      parts.push(
        "고도 " +
          alt +
          (isFiniteNumber(member.altitudeAccuracy)
            ? " ±" + Math.round(member.altitudeAccuracy) + "m"
            : "")
      );
    }
    if (member.accuracy != null) parts.push("정확도 ±" + Math.round(member.accuracy) + "m");
    if (!member.isMe && state.lastPosition) {
      parts.push("거리 " + formatDistance(distanceMeters(state.lastPosition, member)));
    }
    parts.push(formatAge(now - member.updatedAt) + " 전");
    return parts.join(" · ");
  }

  // ---------- 나가기 ----------
  function leave() {
    // 임무 중에 그냥 나가면 기록이 사라진다. 먼저 종료 절차를 밟게 한다.
    if (state.recorder) {
      endMission(true);
      toast("임무를 먼저 종료했습니다. 저장 여부를 정한 뒤 다시 나가기를 눌러 주세요.", 6000);
      return;
    }
    if (state.pendingMission) {
      toast("저장 창을 먼저 처리해 주세요.", 4000);
      return;
    }

    sendLeave();
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.sweepTimer);
    if (state.wakeLock) {
      try {
        state.wakeLock.release();
      } catch (e) {
        /* 이미 해제됨 */
      }
    }
    if (state.client) state.client.end(true);

    // 앱에서 나가면 메시지 수신 서비스까지 완전히 끈다.
    if (window.AndroidBridge && typeof window.AndroidBridge.stopAll === "function") {
      try {
        window.AndroidBridge.stopAll();
      } catch (e) {
        /* 구버전 앱 */
      }
    }

    window.removeEventListener("pagehide", sendLeave);
    window.removeEventListener("beforeunload", sendLeave);
    window.location.reload();
  }

  // ---------- 유틸 ----------
  function makeId() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
    return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDate(date) {
    return (
      date.getFullYear() +
      "년 " +
      (date.getMonth() + 1) +
      "월 " +
      date.getDate() +
      "일 (" +
      ["일", "월", "화", "수", "목", "금", "토"][date.getDay()] +
      ")"
    );
  }

  function formatTime(date) {
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
  }

  function formatDateTime(date) {
    return (
      date.getFullYear() +
      "-" +
      pad2(date.getMonth() + 1) +
      "-" +
      pad2(date.getDate()) +
      " " +
      pad2(date.getHours()) +
      ":" +
      pad2(date.getMinutes())
    );
  }

  function safeFileName(name) {
    return (
      String(name)
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "_")
        .slice(0, 60) || "mission"
    );
  }

  function distanceMeters(a, b) {
    var R = 6371000;
    var dLat = toRad(b.lat - a.lat);
    var dLng = toRad(b.lng - a.lng);
    var s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function formatDistance(m) {
    if (m < 1000) return Math.round(m) + "m";
    return (m / 1000).toFixed(m < 10000 ? 2 : 1) + "km";
  }

  function formatAge(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "초";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "분";
    return Math.floor(m / 60) + "시간";
  }

  function round6(n) {
    return Math.round(n * 1e6) / 1e6;
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && isFinite(n);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var toastTimer = null;
  function toast(message, duration) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, duration || 3000);
  }
})();
