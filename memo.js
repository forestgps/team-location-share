/**
 * 현장 메모 저장소.
 *
 * 메모는 사진/동영상 첨부를 포함하므로 localStorage(약 5MB, 문자열 전용)로는
 * 감당할 수 없다. 그래서 IndexedDB 에 Blob 을 그대로 저장한다.
 *
 * 메모 레코드
 *   {
 *     id, teamKey, lat, lng, text,
 *     createdAt, author, authorId,
 *     remote,                       // 팀원이 만든 메모(첨부는 작성자 기기에만 있음)
 *     media: [{ name, type, size, blob }]
 *   }
 *
 * 저장은 이 기기에만 이뤄진다. 좌표와 메모 본문은 팀 채널로 공유하지만
 * 사진/동영상은 용량 때문에 전송하지 않는다.
 *
 * window.RtlocMemo 로 노출된다.
 */
(function (global) {
  "use strict";

  var DB_NAME = "rtloc";
  var DB_VERSION = 1;
  var STORE = "memos";

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error("이 브라우저는 IndexedDB 를 지원하지 않아 메모를 저장할 수 없습니다."));
        return;
      }

      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("teamKey", "teamKey", { unique: false });
        }
      };

      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("메모 저장소를 열 수 없습니다."));
      };
    });

    return dbPromise;
  }

  function withStore(mode, work) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var result;

        try {
          result = work(store);
        } catch (e) {
          reject(e);
          return;
        }

        tx.oncomplete = function () {
          resolve(result && result.value !== undefined ? result.value : result);
        };
        tx.onerror = function () {
          reject(tx.error || new Error("메모 저장소 작업이 실패했습니다."));
        };
        tx.onabort = function () {
          reject(tx.error || new Error("메모 저장이 중단되었습니다. 저장 공간을 확인해 주세요."));
        };
      });
    });
  }

  function put(memo) {
    return withStore("readwrite", function (store) {
      store.put(memo);
      return memo;
    });
  }

  function remove(id) {
    return withStore("readwrite", function (store) {
      store.delete(id);
      return id;
    });
  }

  /** 특정 팀의 메모를 최신순으로 반환한다. */
  function listByTeam(teamKey) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var index = tx.objectStore(STORE).index("teamKey");
        var request = index.getAll(teamKey);

        request.onsuccess = function () {
          var rows = request.result || [];
          rows.sort(function (a, b) {
            return b.createdAt - a.createdAt;
          });
          resolve(rows);
        };
        request.onerror = function () {
          reject(request.error);
        };
      });
    });
  }

  function get(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
        request.onsuccess = function () {
          resolve(request.result || null);
        };
        request.onerror = function () {
          reject(request.error);
        };
      });
    });
  }

  function newId() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 팀 채널로 보낼 정보. 첨부 파일 자체(Blob)는 빼고 목록(manifest)만 넣는다.
   * 실제 파일은 받는 쪽이 열어 볼 때 요청하면 조각으로 나눠 전송한다.
   */
  function toWire(memo) {
    ensureMediaIds(memo);
    return {
      id: memo.id,
      lat: memo.lat,
      lng: memo.lng,
      text: memo.text,
      createdAt: memo.createdAt,
      author: memo.author,
      authorId: memo.authorId,
      manifest: manifestOf(memo)
    };
  }

  function fromWire(wire, teamKey) {
    var manifest = Array.isArray(wire.manifest) ? wire.manifest : [];

    return {
      id: wire.id,
      teamKey: teamKey,
      lat: wire.lat,
      lng: wire.lng,
      text: typeof wire.text === "string" ? wire.text : "",
      createdAt: wire.createdAt || Date.now(),
      author: wire.author || "대원",
      authorId: wire.authorId || "",
      remote: true,
      // 아직 내려받지 않은 첨부 목록. blob 은 받은 뒤에 채워진다.
      media: manifest.map(function (item) {
        return {
          mediaId: item.mediaId,
          name: item.name || "첨부",
          type: item.type || "application/octet-stream",
          size: item.size || 0,
          blob: null
        };
      })
    };
  }

  /** 내려받은 첨부를 메모에 채워 넣고 저장한다. */
  function attachMedia(memoId, mediaId, info) {
    return get(memoId).then(function (memo) {
      if (!memo) return null;

      var found = false;
      memo.media = (memo.media || []).map(function (item) {
        if (item.mediaId !== mediaId) return item;
        found = true;
        return {
          mediaId: mediaId,
          name: info.name || item.name,
          type: info.type || item.type,
          size: info.blob.size,
          blob: info.blob
        };
      });

      if (!found) {
        memo.media.push({
          mediaId: mediaId,
          name: info.name || "첨부",
          type: info.type || "application/octet-stream",
          size: info.blob.size,
          blob: info.blob
        });
      }

      return put(memo);
    });
  }

  /**
   * 첨부에 mediaId 가 없으면 채워 넣는다.
   * 예전 버전에서 저장된 메모는 mediaId 가 없어 전송 요청을 짝지을 수 없다.
   * @returns {boolean} 하나라도 채웠는지
   */
  function ensureMediaIds(memo) {
    var changed = false;
    (memo.media || []).forEach(function (item) {
      if (!item.mediaId) {
        item.mediaId = newId();
        changed = true;
      }
    });
    return changed;
  }

  /** 다른 기기에서 받은 첨부 목록을 기존 메모에 병합한다(파일은 아직 없음). */
  function mergeManifest(memo, manifest) {
    if (!Array.isArray(manifest)) return false;

    var known = Object.create(null);
    (memo.media || []).forEach(function (item) {
      if (item.mediaId) known[item.mediaId] = true;
    });

    var added = false;
    memo.media = memo.media || [];
    manifest.forEach(function (item) {
      if (!item || !item.mediaId || known[item.mediaId]) return;
      memo.media.push({
        mediaId: item.mediaId,
        name: item.name || "첨부",
        type: item.type || "application/octet-stream",
        size: item.size || 0,
        blob: null
      });
      added = true;
    });

    return added;
  }

  /** 전송용 첨부 목록만 뽑는다. */
  function manifestOf(memo) {
    return (memo.media || []).map(function (item) {
      return {
        mediaId: item.mediaId,
        name: item.name,
        type: item.type,
        size: item.blob ? item.blob.size : item.size
      };
    });
  }

  /** 특정 첨부의 Blob 을 찾는다(전송 요청에 응답할 때 쓴다). */
  function findMedia(memoId, mediaId) {
    return get(memoId).then(function (memo) {
      if (!memo) return null;
      var match = null;
      (memo.media || []).forEach(function (item) {
        if (item.mediaId === mediaId && item.blob) match = item;
      });
      return match;
    });
  }

  global.RtlocMemo = {
    newId: newId,
    put: put,
    remove: remove,
    get: get,
    listByTeam: listByTeam,
    toWire: toWire,
    fromWire: fromWire,
    attachMedia: attachMedia,
    findMedia: findMedia,
    ensureMediaIds: ensureMediaIds,
    mergeManifest: mergeManifest,
    manifestOf: manifestOf
  };
})(window);
