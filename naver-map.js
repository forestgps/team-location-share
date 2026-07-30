/**
 * 네이버 지도 JS API v3 얇은 감싸개.
 *
 * 앱이 지도에 필요한 조작은 열댓 가지뿐이다. 그걸 이 파일에 모아 두고 app.js 는
 * 여기만 부른다. 지도 제공자를 다시 바꿀 일이 생겨도 이 파일만 고치면 된다.
 *
 * 네이버 API 와 다른 지도 라이브러리의 차이 때문에 특별히 처리하는 것들
 *  - 마커에 setOpacity 가 없다. 흐리게 표시하는 것은 아이콘 HTML 의 클래스로 한다.
 *  - 툴팁(호버 라벨)이 없다. 대원 이름은 마커 HTML 안에 항상 그려 넣는다.
 *    휴대폰에는 호버가 없어서 툴팁은 원래도 쓸모가 적었다.
 *  - 레이어 그룹이 없다. 여러 오버레이를 한꺼번에 넣고 빼는 묶음을 직접 만든다.
 *  - 클릭 이벤트의 좌표는 e.coord 다. lat()/lng() 메서드로 값을 꺼낸다.
 *
 * window.RtlocMap 으로 노출된다.
 */
(function (global) {
  "use strict";

  function api() {
    return global.naver && global.naver.maps ? global.naver.maps : null;
  }

  /** 네이버 지도 스크립트가 실제로 올라왔는지. */
  function isReady() {
    var m = api();
    return !!(m && m.Map && m.Marker && m.Circle && m.Polyline && m.LatLng && m.Event);
  }

  function latLng(pair) {
    // new 는 반드시 LatLng 에 걸어야 한다.
    // new api().LatLng(...) 로 쓰면 api 가 생성자로 불리고 LatLng 은 new 없이 호출된다.
    var m = api();
    return new m.LatLng(pair[0], pair[1]);
  }

  /**
   * 지도 스크립트를 못 받았을 때 쓰는 무동작 객체.
   *
   * 지도가 없다고 앱 전체가 멈추면 대원이 나가기도 못 누르고 갇힌다.
   * 메시지·메모 목록·임무 기록처럼 지도가 없어도 되는 기능은 계속 쓸 수 있게,
   * 지도 호출만 조용히 흘려보낸다.
   */
  function noop() {
    var self = {
      __isNoop: true,
      raw: function () { return null; },
      on: function () { return self; },
      setView: function () { return self; },
      getZoom: function () { return 7; },
      fitBounds: function () { return self; },
      remove: function () { return self; },
      setPosition: function () { return self; },
      setHtml: function () { return self; },
      onClick: function () { return self; },
      setCenter: function () { return self; },
      setRadius: function () { return self; },
      setColor: function () { return self; },
      setPath: function () { return self; },
      setMapRaw: function () { return self; },
      addTo: function () { return self; },
      add: function () { return self; }
    };
    return self;
  }

  function toPath(pairs) {
    var m = api();
    return pairs.map(function (p) {
      return new m.LatLng(p[0], p[1]);
    });
  }

  // ---------- 묶음 (레이어 그룹 대신) ----------

  function group() {
    if (!isReady()) return noop();
    return {
      __isGroup: true,
      items: [],
      map: null,

      add: function (overlay) {
        this.items.push(overlay);
        if (this.map) overlay.setMapRaw(this.map);
        return this;
      },

      addTo: function (mapWrapper) {
        this.map = mapWrapper.raw();
        this.items.forEach(function (o) {
          o.setMapRaw(this.map);
        }, this);
        return this;
      },

      remove: function () {
        this.items.forEach(function (o) {
          o.remove();
        });
        this.items = [];
        this.map = null;
      }
    };
  }

  /** 오버레이 공통 동작. addTo 는 지도와 묶음을 모두 받는다. */
  function decorate(wrapper, overlay) {
    wrapper.setMapRaw = function (rawMap) {
      overlay.setMap(rawMap);
      return wrapper;
    };
    wrapper.addTo = function (target) {
      if (!target) return wrapper;
      if (target.__isGroup) target.add(wrapper);
      else overlay.setMap(target.raw());
      return wrapper;
    };
    wrapper.remove = function () {
      overlay.setMap(null);
      return wrapper;
    };
    wrapper.raw = function () {
      return overlay;
    };
    return wrapper;
  }

  // ---------- 마커 ----------

  /**
   * HTML 아이콘 마커.
   * @param {{position: number[], html: string, size?: number[], anchor?: number[], zIndex?: number}} opts
   */
  function marker(opts) {
    if (!isReady()) return noop();
    var m = api();
    var icon = { content: opts.html };
    if (opts.size) icon.size = new m.Size(opts.size[0], opts.size[1]);
    if (opts.anchor) icon.anchor = new m.Point(opts.anchor[0], opts.anchor[1]);

    var overlay = new m.Marker({
      position: latLng(opts.position),
      icon: icon,
      zIndex: opts.zIndex || 0
    });

    var wrapper = {
      setPosition: function (pair) {
        overlay.setPosition(latLng(pair));
        return wrapper;
      },
      setHtml: function (html) {
        var next = { content: html };
        if (opts.size) next.size = new m.Size(opts.size[0], opts.size[1]);
        if (opts.anchor) next.anchor = new m.Point(opts.anchor[0], opts.anchor[1]);
        overlay.setIcon(next);
        return wrapper;
      },
      onClick: function (fn) {
        m.Event.addListener(overlay, "click", function () {
          fn();
        });
        return wrapper;
      }
    };

    return decorate(wrapper, overlay);
  }

  // ---------- 정확도 원 ----------

  function circle(opts) {
    if (!isReady()) return noop();
    var m = api();
    var overlay = new m.Circle({
      center: latLng(opts.center),
      radius: opts.radius || 0,
      strokeColor: opts.color,
      strokeWeight: 1,
      strokeOpacity: 0.9,
      fillColor: opts.color,
      fillOpacity: 0.08
    });

    var wrapper = {
      setCenter: function (pair) {
        overlay.setCenter(latLng(pair));
        return wrapper;
      },
      setRadius: function (meters) {
        // 반지름 0 이면 네이버가 그리기를 건너뛴다. 그대로 넘겨도 안전하다.
        overlay.setRadius(meters || 0);
        return wrapper;
      },
      setColor: function (color) {
        overlay.setOptions({ strokeColor: color, fillColor: color });
        return wrapper;
      }
    };

    return decorate(wrapper, overlay);
  }

  // ---------- 경로선 ----------

  function polyline(opts) {
    if (!isReady()) return noop();
    var m = api();
    var overlay = new m.Polyline({
      path: toPath(opts.path),
      strokeColor: opts.color,
      strokeWeight: opts.weight || 4,
      strokeOpacity: opts.opacity == null ? 0.85 : opts.opacity,
      strokeLineCap: "round",
      strokeLineJoin: "round"
    });

    var wrapper = {
      setPath: function (pairs) {
        overlay.setPath(toPath(pairs));
        return wrapper;
      },
      setColor: function (color) {
        overlay.setOptions({ strokeColor: color });
        return wrapper;
      }
    };

    return decorate(wrapper, overlay);
  }

  // ---------- 지도 ----------

  /**
   * @param {string} containerId 지도를 넣을 요소 id
   * @param {{center: number[], zoom: number}} opts
   */
  function createMap(containerId, opts) {
    if (!isReady()) return noop();
    var m = api();
    var raw = new m.Map(containerId, {
      center: latLng(opts.center),
      zoom: opts.zoom,
      // 확대/축소 버튼은 왼쪽 아래에 둔다. 왼쪽 위는 메모 버튼 자리다.
      zoomControl: true,
      zoomControlOptions: {
        position: m.Position.BOTTOM_LEFT,
        style: m.ZoomControlStyle ? m.ZoomControlStyle.SMALL : undefined
      },
      // 네이버 로고와 저작권 표시는 이용 약관상 켜 둔 채로 두어야 한다.
      logoControl: true,
      mapDataControl: true,
      scaleControl: true
    });

    var wrapper = {
      raw: function () {
        return raw;
      },

      /**
       * @param {string} type "click" 또는 "dragstart"
       * @param {function} fn click 은 {lat, lng} 를 받는다
       */
      on: function (type, fn) {
        if (type === "click") {
          m.Event.addListener(raw, "click", function (e) {
            var c = coordOf(e);
            if (c) fn(c);
          });
        } else {
          m.Event.addListener(raw, type, function () {
            fn();
          });
        }
        return wrapper;
      },

      setView: function (pair, zoom) {
        // 따라가기 중에는 매 위치마다 불린다. 애니메이션 없이 즉시 옮긴다.
        raw.setCenter(latLng(pair));
        if (typeof zoom === "number") raw.setZoom(zoom);
        return wrapper;
      },

      getZoom: function () {
        return raw.getZoom();
      },

      /**
       * @param {number[][]} bounds [[남서위, 남서경], [북동위, 북동경]]
       * @param {number} padding 픽셀 여백
       */
      fitBounds: function (bounds, padding) {
        var p = padding || 0;
        raw.fitBounds(bounds, { top: p, right: p, bottom: p, left: p });
        return wrapper;
      },

      /** 오버레이 하나 또는 묶음을 지도에서 뺀다. */
      remove: function (overlay) {
        if (overlay && typeof overlay.remove === "function") overlay.remove();
        return wrapper;
      }
    };

    return wrapper;
  }

  /**
   * 포인터 이벤트에서 좌표를 꺼낸다.
   *
   * API 소스 기준으로 payload 는 {offset, point, coord, pointerEvent, domEvent, ...} 이고
   * coord 가 항상 들어 있다. latlng 은 투영이 지원할 때만 추가되므로 예비로만 본다.
   */
  function coordOf(e) {
    var c = e && (e.coord || e.latlng);
    if (!c) return null;
    if (typeof c.lat === "function") return { lat: c.lat(), lng: c.lng() };
    if (typeof c.lat === "number") return { lat: c.lat, lng: c.lng };
    return null;
  }

  global.RtlocMap = {
    isReady: isReady,
    createMap: createMap,
    marker: marker,
    circle: circle,
    polyline: polyline,
    group: group
  };
})(window);
