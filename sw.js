/**
 * 앱 셸 캐시용 서비스 워커.
 *
 * 목적은 오프라인 동작이 아니라 빠른 실행과 불안정한 회선에서의 안정성이다.
 * 위치 공유 자체는 실시간 연결이 필요하므로 네트워크가 없으면 동작하지 않는다.
 *
 * 캐시 전략
 *  - 앱 셸(HTML/CSS/JS): 네트워크 우선, 실패 시 캐시. 배포 직후 최신 코드를 받게 한다.
 *  - 지도 타일: 캐시하지 않는다(용량이 크고 변동이 많다).
 */
var CACHE = "rtloc-shell-v18";

var SHELL = [
  "./",
  "index.html",
  "styles.css",
  "crypto-team.js",
  "palette.js",
  "alert.js",
  "chat.js",
  "mgrs.js",
  "media.js",
  "memo.js",
  "mission.js",
  "route-video.js",
  "naver-map.js",
  "geoid.js",
  "app.js",
  "manifest.json",
  "icons/icon.svg",
  "https://unpkg.com/mqtt@5.7.0/dist/mqtt.min.js"
  // 네이버 지도 스크립트는 캐시하지 않는다. 로더가 실행 시점에 다른 리소스를 더
  // 받아오고 키가 URL 에 들어 있어서, 캐시해 두면 갱신과 인증이 어긋난다.
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 일부 리소스가 실패해도 설치는 진행한다.
      return Promise.all(
        SHELL.map(function (url) {
          return cache.add(new Request(url, { cache: "reload" })).catch(function () {});
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            return key === CACHE ? null : caches.delete(key);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;

  if (request.method !== "GET") return;

  var url = new URL(request.url);

  // 지도 타일은 캐시 대상이 아니다. 용량이 크고 변동이 많다.
  // OSM 은 임무 영상 배경에 계속 쓰이고, 네이버는 화면 지도에 쓰인다.
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) return;

  // 네이버 지도는 스크립트·타일·글꼴을 여러 도메인에서 받아온다.
  // 캐시가 끼면 키 인증과 갱신이 어긋나므로 전부 그대로 통과시킨다.
  if (/(^|\.)(map\.naver\.com|naver\.net|pstatic\.net|ntruss\.com)$/.test(url.hostname)) return;

  // 실시간 연결은 건드리지 않는다.
  if (url.protocol === "ws:" || url.protocol === "wss:") return;

  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(request, copy).catch(function () {});
          });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request).then(function (cached) {
          return cached || Response.error();
        });
      })
  );
});
