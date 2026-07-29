/**
 * 임무 경로를 영상으로 만든다. 서버 없이 브라우저에서만 처리한다.
 *
 * 처리 순서
 *  1) 전체 경로를 감싸는 범위에서 줌 레벨과 화면 중심을 정한다
 *  2) 지도 타일을 한 번만 내려받아 배경 캔버스를 만든다
 *  3) 캔버스에 경로를 시간순으로 누적해 그리며 실시간으로 재생한다
 *  4) 그 캔버스를 MediaRecorder 로 녹화해 mp4 파일을 만든다
 *
 * MediaRecorder 는 실제 경과 시간으로 프레임에 시각을 매긴다. 그래서 재생 길이만큼
 * 실제로 기다려야 하고, 그동안 화면이 보이는 상태여야 한다(백그라운드로 가면
 * requestAnimationFrame 이 멈춰 영상이 끊긴다).
 *
 * mp4 컨테이너를 지원하지 않는 브라우저에서는 webm 으로 떨어진다. 호출한 쪽에서
 * 결과의 ext 를 보고 파일 이름을 정해야 한다.
 *
 * window.RtlocRouteVideo 로 노출된다.
 */
(function (global) {
  "use strict";

  var WIDTH = 1280;
  var HEIGHT = 720;
  var FPS = 30;
  var PLAY_SEC = 20; // 경로 재생 길이
  var TAIL_SEC = 2; // 마지막 화면을 잠시 더 보여주는 시간
  var TILE = 256;
  var MAX_TILES = 64; // 타일 서버 과다 요청 방지
  var TILE_CONCURRENCY = 4;
  var PADDING = 80; // 경로가 화면 가장자리에 붙지 않게 하는 여백
  var PANEL_H = 96; // 하단 정보 패널
  var MAP_H = HEIGHT - PANEL_H;
  var BITRATE = 5000000;

  var FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

  // mp4 를 먼저 시도하고, 안 되면 webm 으로 내려간다.
  var MIME_CANDIDATES = [
    'video/mp4;codecs="avc1.42E01E"',
    'video/mp4;codecs=avc1',
    "video/mp4",
    'video/webm;codecs="vp9"',
    'video/webm;codecs="vp8"',
    "video/webm"
  ];

  var FALLBACK_COLORS = ["#ff5722", "#2196f3", "#4caf50", "#ffc107", "#9c27b0", "#00bcd4"];

  // ---------- 지원 여부 ----------

  /** 이 브라우저에서 영상을 만들 수 있는지. */
  function isSupported() {
    return !!(
      global.MediaRecorder &&
      global.HTMLCanvasElement &&
      HTMLCanvasElement.prototype.captureStream &&
      typeof MediaRecorder.isTypeSupported === "function"
    );
  }

  /** 실제로 쓸 컨테이너를 고른다. 지원하는 게 없으면 null. */
  function pickMime() {
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return null;
  }

  /** 고른 컨테이너가 mp4 인지. UI 안내 문구를 정할 때 쓴다. */
  function willBeMp4() {
    var mime = isSupported() ? pickMime() : null;
    return !!mime && mime.indexOf("video/mp4") === 0;
  }

  function extOf(mime) {
    return mime && mime.indexOf("video/mp4") === 0 ? "mp4" : "webm";
  }

  // ---------- 좌표 변환 (웹 메르카토르) ----------

  function lngToTileX(lng, z) {
    return ((lng + 180) / 360) * Math.pow(2, z);
  }

  function latToTileY(lat, z) {
    var s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z);
  }

  /** 경로 전체가 화면에 들어오는 가장 큰 줌을 고른다. */
  function pickZoom(bounds) {
    var usableW = WIDTH - PADDING * 2;
    var usableH = MAP_H - PADDING * 2;

    for (var z = 18; z >= 1; z--) {
      var w = Math.abs(lngToTileX(bounds.maxLng, z) - lngToTileX(bounds.minLng, z)) * TILE;
      var h = Math.abs(latToTileY(bounds.minLat, z) - latToTileY(bounds.maxLat, z)) * TILE;
      if (w <= usableW && h <= usableH) return z;
    }
    return 1;
  }

  /** mission.tracks 의 모든 점을 감싸는 범위. 점이 없으면 null. */
  function computeBounds(tracks) {
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    var count = 0;

    tracks.forEach(function (t) {
      (t.points || []).forEach(function (p) {
        var lat = p[0];
        var lng = p[1];
        if (!isFinite(lat) || !isFinite(lng)) return;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        count++;
      });
    });

    if (count === 0) return null;

    // 점이 한 곳에 모여 있으면 범위가 0이 되어 줌 계산이 무너진다. 살짝 넓힌다.
    if (maxLat - minLat < 0.0005) {
      minLat -= 0.00025;
      maxLat += 0.00025;
    }
    if (maxLng - minLng < 0.0005) {
      minLng -= 0.00025;
      maxLng += 0.00025;
    }

    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  // ---------- 지도 배경 ----------

  function loadTile(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      // 캔버스가 오염되면 captureStream 이 막힌다. 반드시 src 보다 먼저 지정한다.
      img.crossOrigin = "anonymous";
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        resolve(null); // 타일 하나 실패는 무시하고 계속한다
      };
      img.src = url;
    });
  }

  /**
   * 타일을 모아 배경 캔버스와 좌표 변환 함수를 만든다.
   * 배경은 한 번만 만들고 모든 프레임이 재사용한다.
   */
  function buildBasemap(bounds, zoom, onProgress) {
    var centerLat = (bounds.minLat + bounds.maxLat) / 2;
    var centerLng = (bounds.minLng + bounds.maxLng) / 2;

    var originX = lngToTileX(centerLng, zoom) * TILE - WIDTH / 2;
    var originY = latToTileY(centerLat, zoom) * TILE - MAP_H / 2;

    var canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = MAP_H;
    var ctx = canvas.getContext("2d");

    // 타일을 못 받아도 영상이 나오도록 기본 배경을 먼저 칠한다.
    ctx.fillStyle = "#e8e4dc";
    ctx.fillRect(0, 0, WIDTH, MAP_H);

    var maxIndex = Math.pow(2, zoom) - 1;
    var jobs = [];
    for (var tx = Math.floor(originX / TILE); tx <= Math.floor((originX + WIDTH) / TILE); tx++) {
      for (var ty = Math.floor(originY / TILE); ty <= Math.floor((originY + MAP_H) / TILE); ty++) {
        if (ty < 0 || ty > maxIndex) continue;
        jobs.push({
          tx: tx,
          ty: ty,
          wrappedX: (((tx % (maxIndex + 1)) + maxIndex + 1) % (maxIndex + 1))
        });
      }
    }
    jobs = jobs.slice(0, MAX_TILES);

    var loaded = 0;
    var done = 0;
    var next = 0;

    function worker() {
      if (next >= jobs.length) return Promise.resolve();
      var job = jobs[next++];
      var url = "https://tile.openstreetmap.org/" + zoom + "/" + job.wrappedX + "/" + job.ty + ".png";
      return loadTile(url).then(function (img) {
        if (img) {
          ctx.drawImage(img, job.tx * TILE - originX, job.ty * TILE - originY, TILE, TILE);
          loaded++;
        }
        done++;
        if (onProgress) onProgress(done / jobs.length);
        return worker();
      });
    }

    var workers = [];
    for (var i = 0; i < Math.min(TILE_CONCURRENCY, jobs.length); i++) workers.push(worker());

    return Promise.all(workers).then(function () {
      if (loaded === 0) {
        // 배경이 없으면 위치 감각이 사라지므로 최소한 격자를 그린다.
        ctx.strokeStyle = "#d5d0c6";
        ctx.lineWidth = 1;
        for (var x = 0; x < WIDTH; x += 64) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, MAP_H);
          ctx.stroke();
        }
        for (var y = 0; y < MAP_H; y += 64) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(WIDTH, y);
          ctx.stroke();
        }
      } else {
        // OpenStreetMap 이용 조건에 따른 저작자 표시.
        ctx.font = "12px " + FONT;
        var credit = "© OpenStreetMap contributors";
        var cw = ctx.measureText(credit).width;
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillRect(WIDTH - cw - 14, MAP_H - 22, cw + 12, 18);
        ctx.fillStyle = "#333333";
        ctx.fillText(credit, WIDTH - cw - 8, MAP_H - 9);
      }

      return {
        canvas: canvas,
        loaded: loaded,
        total: jobs.length,
        zoom: zoom,
        project: function (lat, lng) {
          return {
            x: lngToTileX(lng, zoom) * TILE - originX,
            y: latToTileY(lat, zoom) * TILE - originY
          };
        }
      };
    });
  }

  // ---------- 표기 ----------

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    return (
      d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
    );
  }

  function fmtDuration(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + "시간 " + m + "분 " + sec + "초";
    if (m > 0) return m + "분 " + sec + "초";
    return sec + "초";
  }

  function fmtDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
  }

  // ---------- 본체 ----------

  /**
   * 임무 경로 영상을 만든다.
   *
   * @param {object} mission RtlocMission 이 만든 임무 객체
   * @param {{onProgress?: function(number, string), playSeconds?: number}} [opts]
   * @returns {Promise<{blob: Blob, mime: string, ext: string, durationSec: number,
   *                    tilesLoaded: number, tilesTotal: number, zoom: number,
   *                    memberCount: number}>}
   */
  function render(mission, opts) {
    opts = opts || {};
    var report = function (pct, phase) {
      if (opts.onProgress) opts.onProgress(Math.max(0, Math.min(100, Math.round(pct))), phase);
    };

    if (!isSupported()) {
      return Promise.reject(new Error("이 브라우저는 영상 만들기를 지원하지 않습니다."));
    }
    var mime = pickMime();
    if (!mime) {
      return Promise.reject(new Error("이 브라우저가 지원하는 영상 형식이 없습니다."));
    }

    var playSec = opts.playSeconds || PLAY_SEC;
    var tracks = (mission.tracks || []).filter(function (t) {
      return t.points && t.points.length > 0;
    });

    if (tracks.length === 0) {
      return Promise.reject(new Error("기록된 이동 경로가 없어 영상을 만들 수 없습니다."));
    }

    var bounds = computeBounds(tracks);
    if (!bounds) {
      return Promise.reject(new Error("기록된 위치가 없어 영상을 만들 수 없습니다."));
    }

    var zoom = pickZoom(bounds);

    report(2, "지도 준비 중");

    return buildBasemap(bounds, zoom, function (frac) {
      report(2 + frac * 20, "지도 내려받는 중");
    }).then(function (base) {
      report(22, "영상 녹화 중");

      // 시간 범위
      var tMin = Infinity;
      var tMax = -Infinity;
      tracks.forEach(function (t) {
        t.points.forEach(function (p) {
          if (p[2] < tMin) tMin = p[2];
          if (p[2] > tMax) tMax = p[2];
        });
      });
      if (!isFinite(tMin)) {
        tMin = mission.startedAt;
        tMax = mission.endedAt || Date.now();
      }
      if (tMax <= tMin) tMax = tMin + 1000;

      // 대원별 렌더 정보 (화면 좌표로 미리 투영해 둔다)
      var members = tracks.map(function (t, i) {
        var pts = t.points
          .slice()
          .sort(function (a, b) {
            return a[2] - b[2];
          })
          .map(function (p) {
            var xy = base.project(p[0], p[1]);
            return { x: xy.x, y: xy.y, t: p[2] };
          });

        return {
          name: t.name || "대원",
          color: t.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
          points: pts,
          meters: typeof t.distance === "number" ? t.distance : 0
        };
      });

      var totalMeters = members.reduce(function (s, m) {
        return s + m.meters;
      }, 0);
      var missionName = mission.name || mission.teamName || "임무";

      var canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      var ctx = canvas.getContext("2d");

      function drawFrame(prog) {
        var now = tMin + (tMax - tMin) * prog;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.drawImage(base.canvas, 0, 0);

        // 지도를 살짝 눌러 경로가 잘 보이게 한다.
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(0, 0, WIDTH, MAP_H);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, WIDTH, MAP_H);
        ctx.clip();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        members.forEach(function (m) {
          var visible = [];
          for (var i = 0; i < m.points.length; i++) {
            if (m.points[i].t > now) break;
            visible.push(m.points[i]);
          }
          if (visible.length === 0) return;

          ctx.beginPath();
          for (var j = 0; j < visible.length; j++) {
            if (j === 0) ctx.moveTo(visible[j].x, visible[j].y);
            else ctx.lineTo(visible[j].x, visible[j].y);
          }
          ctx.strokeStyle = m.color;
          ctx.lineWidth = 4;
          ctx.globalAlpha = 0.9;
          ctx.stroke();
          ctx.globalAlpha = 1;

          var head = visible[visible.length - 1];
          ctx.beginPath();
          ctx.arc(head.x, head.y, 9, 0, Math.PI * 2);
          ctx.fillStyle = m.color;
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#ffffff";
          ctx.stroke();

          ctx.font = "bold 15px " + FONT;
          var tw = ctx.measureText(m.name).width;
          ctx.fillStyle = m.color;
          ctx.fillRect(head.x + 13, head.y - 22, tw + 12, 22);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(m.name, head.x + 19, head.y - 6);
        });

        ctx.restore();

        // 하단 정보 패널
        ctx.fillStyle = "#1b1b1b";
        ctx.fillRect(0, MAP_H, WIDTH, PANEL_H);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px " + FONT;
        ctx.fillText(missionName, 20, MAP_H + 30);

        ctx.font = "14px " + FONT;
        ctx.fillStyle = "#bdbdbd";
        ctx.fillText(fmtClock(now), 20, MAP_H + 54);
        ctx.fillText(
          "대원 " + members.length + "명 · 총 이동 " + fmtDistance(totalMeters) +
            " · 소요 " + fmtDuration(tMax - tMin),
          20,
          MAP_H + 76
        );

        // 범례 (대원 색)
        var lx = WIDTH - 20;
        ctx.font = "bold 14px " + FONT;
        for (var k = members.length - 1; k >= 0; k--) {
          var mm = members[k];
          var text = mm.name + " " + fmtDistance(mm.meters);
          var w = ctx.measureText(text).width;
          lx -= w + 26;
          if (lx < 480) break; // 왼쪽 문구와 겹치면 그만
          ctx.fillStyle = mm.color;
          ctx.beginPath();
          ctx.arc(lx + 6, MAP_H + 30, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.fillText(text, lx + 18, MAP_H + 35);
        }

        // 진행 바
        ctx.fillStyle = "#424242";
        ctx.fillRect(0, HEIGHT - 6, WIDTH, 6);
        ctx.fillStyle = "#4caf50";
        ctx.fillRect(0, HEIGHT - 6, WIDTH * prog, 6);
      }

      // 녹화가 시작되기 전에 첫 프레임을 올려 둔다.
      drawFrame(0);

      var stream = canvas.captureStream(FPS);
      var recorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
      } catch (e) {
        stopStream(stream);
        return Promise.reject(new Error("영상 녹화를 시작할 수 없습니다: " + e.message));
      }

      var chunks = [];
      recorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      return new Promise(function (resolve, reject) {
        var totalMs = (playSec + TAIL_SEC) * 1000;
        var startedAt = 0;
        var finished = false;

        recorder.onerror = function (ev) {
          if (finished) return;
          finished = true;
          stopStream(stream);
          reject(new Error("녹화 중 오류가 발생했습니다: " + ((ev.error && ev.error.name) || "unknown")));
        };

        recorder.onstop = function () {
          stopStream(stream);
          var blob = new Blob(chunks, { type: mime });
          if (!blob.size) {
            reject(new Error("영상 데이터가 만들어지지 않았습니다."));
            return;
          }
          report(100, "완료");
          resolve({
            blob: blob,
            mime: mime,
            ext: extOf(mime),
            durationSec: playSec + TAIL_SEC,
            tilesLoaded: base.loaded,
            tilesTotal: base.total,
            zoom: base.zoom,
            memberCount: members.length
          });
        };

        function step(now) {
          if (finished) return;
          if (!startedAt) startedAt = now;
          var elapsed = now - startedAt;
          var prog = Math.min(1, elapsed / (playSec * 1000));

          drawFrame(prog);
          report(22 + (Math.min(1, elapsed / totalMs) * 76), "영상 녹화 중");

          if (elapsed >= totalMs) {
            finished = true;
            try {
              recorder.stop();
            } catch (e) {
              stopStream(stream);
              reject(new Error("녹화를 끝내지 못했습니다: " + e.message));
            }
            return;
          }
          requestAnimationFrame(step);
        }

        try {
          recorder.start();
        } catch (e) {
          stopStream(stream);
          reject(new Error("영상 녹화를 시작할 수 없습니다: " + e.message));
          return;
        }
        requestAnimationFrame(step);
      });
    });
  }

  function stopStream(stream) {
    try {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
    } catch (e) {
      /* 이미 정리된 경우 */
    }
  }

  global.RtlocRouteVideo = {
    isSupported: isSupported,
    willBeMp4: willBeMp4,
    pickMime: pickMime,
    render: render,
    PLAY_SEC: PLAY_SEC,
    TAIL_SEC: TAIL_SEC
  };
})(window);
