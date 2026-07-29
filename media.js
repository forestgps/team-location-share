/**
 * 메모 첨부(사진/동영상)를 팀 채널로 전송하는 모듈.
 *
 * 서버가 없으므로 파일을 올려 둘 곳이 없다. 그래서 첨부를 작은 조각으로 잘라
 * 위치 정보와 똑같이 암호화해서 MQTT 로 보내고, 받는 쪽에서 다시 합친다.
 *
 * 설계 이유
 *  - 조각 크기를 24KB 로 둔다. base64 로 부풀고 암호화 봉투가 붙어도 한 메시지가
 *    50KB 안쪽이라 공개 브로커의 패킷 크기 제한(보통 256KB~1MB)에 걸리지 않는다.
 *  - 사진은 보내기 전에 축소한다. 원본 4MB 사진이 대개 300KB 이하로 줄어
 *    전송이 현실적인 시간에 끝난다.
 *  - 동영상은 브라우저에서 재인코딩할 수 없어 원본 그대로 보낸다. 그래서 용량이
 *    크면 시간이 오래 걸린다는 점을 사용자에게 알린다.
 *  - 모든 첨부를 무조건 뿌리지 않는다. 받는 쪽이 메모를 열어 볼 때 요청하고,
 *    작성자가 그때 보내준다(요청 기반). 채널 낭비를 막는다.
 *
 * window.RtlocMedia 로 노출된다.
 */
(function (global) {
  "use strict";

  var CHUNK_SIZE = 24 * 1024; // 조각 하나의 원본 바이트 수
  var CHUNK_DELAY = 25; // 조각 사이 간격(ms). 브로커를 몰아치지 않기 위함
  var IMAGE_MAX_DIMENSION = 1600; // 사진 축소 기준 (긴 변)
  var IMAGE_QUALITY = 0.75;
  var LARGE_FILE_WARNING = 15 * 1024 * 1024; // 이 이상이면 경고
  var ASSEMBLE_TIMEOUT = 45000; // 조각이 끊기면 이 시간 후 실패 처리
  var SHRINK_TIMEOUT = 12000; // 사진 축소가 이 시간 안에 안 끝나면 원본을 그대로 쓴다

  // ---------- 사진 축소 ----------

  /**
   * 사진을 긴 변 기준으로 축소하고 JPEG 로 다시 인코딩한다.
   * 축소가 불가능하거나 원본이 더 작으면 원본을 그대로 돌려준다.
   */
  function shrinkImage(file) {
    var type = (file && file.type) || "";
    if (type.indexOf("image/") !== 0) return Promise.resolve(file);
    // GIF 는 애니메이션이 깨지므로 건드리지 않는다.
    if (type === "image/gif") return Promise.resolve(file);

    return new Promise(function (resolve) {
      // 축소는 어디까지나 편의 기능이다. 어떤 이유로든 실패하거나 응답이 없으면
      // 원본을 그대로 첨부해야 한다. 여기서 멈추면 첨부 자체가 안 되기 때문이다.
      var settled = false;
      var url = null;
      var timer = null;

      function done(result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (url) {
          try {
            URL.revokeObjectURL(url);
          } catch (e) {
            /* 이미 해제됨 */
          }
        }
        resolve(result || file);
      }

      // HEIC 처럼 WebView 가 디코딩하지 못하는 형식은 onload/onerror 가 모두
      // 오지 않는 기기가 있다. 그럴 때도 첨부가 진행되도록 시간 제한을 둔다.
      timer = setTimeout(function () {
        done(file);
      }, SHRINK_TIMEOUT);

      try {
        url = URL.createObjectURL(file);
      } catch (e) {
        done(file);
        return;
      }

      var img = new Image();

      img.onload = function () {
        try {
          var longSide = Math.max(img.width, img.height);
          if (!longSide || longSide <= IMAGE_MAX_DIMENSION) {
            done(file);
            return;
          }

          var scale = IMAGE_MAX_DIMENSION / longSide;
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));

          var ctx = canvas.getContext("2d");
          if (!ctx) {
            done(file);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          if (!canvas.toBlob) {
            done(file);
            return;
          }

          canvas.toBlob(
            function (blob) {
              // 축소 결과가 더 크거나 비어 있으면(드물지만) 원본을 쓴다.
              done(blob && blob.size > 0 && blob.size < file.size ? blob : file);
            },
            "image/jpeg",
            IMAGE_QUALITY
          );
        } catch (e) {
          done(file);
        }
      };

      img.onerror = function () {
        done(file); // 축소 실패해도 전송은 가능해야 한다
      };

      img.src = url;
    });
  }

  // ---------- 조각 나누기 / 합치기 ----------

  function chunkCount(size) {
    return Math.max(1, Math.ceil(size / CHUNK_SIZE));
  }

  /** blob 의 seq 번째 조각을 base64 문자열로 읽는다. */
  function readChunk(blob, seq) {
    var start = seq * CHUNK_SIZE;
    var slice = blob.slice(start, Math.min(start + CHUNK_SIZE, blob.size));

    return slice.arrayBuffer
      ? slice.arrayBuffer().then(toBase64)
      : new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            resolve(toBase64(reader.result));
          };
          reader.onerror = function () {
            reject(reader.error);
          };
          reader.readAsArrayBuffer(slice);
        });
  }

  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    // 인수 개수 제한을 피하려고 나눠서 처리한다.
    var step = 8192;
    for (var i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * 첨부 하나를 조각으로 나눠 순차 전송한다.
   * @param {Blob} blob
   * @param {function(Object):void} send 조각 메시지를 발행하는 함수
   * @param {function(number, number):void} [onProgress] (보낸 조각 수, 전체)
   * @returns {{promise: Promise, cancel: function}}
   */
  function sendBlob(blob, meta, send, onProgress) {
    var total = chunkCount(blob.size);
    var cancelled = false;

    var promise = new Promise(function (resolve, reject) {
      function step(seq) {
        if (cancelled) {
          resolve({ cancelled: true, sent: seq });
          return;
        }
        if (seq >= total) {
          resolve({ cancelled: false, sent: total });
          return;
        }

        readChunk(blob, seq).then(function (data) {
          send({
            seq: seq,
            total: total,
            size: blob.size,
            type: meta.type,
            name: meta.name,
            data: data
          });
          if (onProgress) onProgress(seq + 1, total);
          setTimeout(function () {
            step(seq + 1);
          }, CHUNK_DELAY);
        }, reject);
      }

      step(0);
    });

    return {
      promise: promise,
      cancel: function () {
        cancelled = true;
      }
    };
  }

  /**
   * 받은 조각을 모아 Blob 으로 복원한다.
   * @param {function(string, Object):void} onComplete (mediaId, {blob, name, type, size})
   * @param {function(string, string):void} onFail (mediaId, 이유)
   */
  function createAssembler(onComplete, onFail, onProgress) {
    var jobs = Object.create(null);

    function reset(mediaId) {
      var job = jobs[mediaId];
      if (job && job.timer) clearTimeout(job.timer);
      delete jobs[mediaId];
    }

    function armTimeout(mediaId) {
      var job = jobs[mediaId];
      if (!job) return;
      if (job.timer) clearTimeout(job.timer);
      job.timer = setTimeout(function () {
        var received = job.received;
        var total = job.total;
        reset(mediaId);
        if (onFail) onFail(mediaId, "전송이 중단되었습니다 (" + received + "/" + total + " 조각)");
      }, ASSEMBLE_TIMEOUT);
    }

    return {
      /** 조각 메시지를 넣는다. */
      accept: function (mediaId, chunk) {
        if (!chunk || typeof chunk.data !== "string") return;

        var job = jobs[mediaId];
        if (!job) {
          job = jobs[mediaId] = {
            parts: new Array(chunk.total),
            received: 0,
            total: chunk.total,
            name: chunk.name,
            type: chunk.type,
            size: chunk.size,
            timer: null
          };
        }

        if (job.parts[chunk.seq] === undefined) {
          job.parts[chunk.seq] = fromBase64(chunk.data);
          job.received += 1;
        }

        if (onProgress) onProgress(mediaId, job.received, job.total);

        if (job.received >= job.total) {
          var blob = new Blob(job.parts, { type: job.type || "application/octet-stream" });
          var info = { blob: blob, name: job.name, type: job.type, size: blob.size };
          reset(mediaId);
          if (onComplete) onComplete(mediaId, info);
          return;
        }

        armTimeout(mediaId);
      },

      isActive: function (mediaId) {
        return !!jobs[mediaId];
      },

      cancel: reset
    };
  }

  function estimateSeconds(size) {
    // 조각당 지연 + 전송 오버헤드를 감안한 대략치
    return Math.ceil((chunkCount(size) * (CHUNK_DELAY + 35)) / 1000);
  }

  global.RtlocMedia = {
    CHUNK_SIZE: CHUNK_SIZE,
    LARGE_FILE_WARNING: LARGE_FILE_WARNING,
    IMAGE_MAX_DIMENSION: IMAGE_MAX_DIMENSION,
    shrinkImage: shrinkImage,
    chunkCount: chunkCount,
    readChunk: readChunk,
    sendBlob: sendBlob,
    createAssembler: createAssembler,
    estimateSeconds: estimateSeconds
  };
})(window);
