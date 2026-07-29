/**
 * 대원 색상 배분.
 *
 * 같은 팀 안에서 색이 겹치지 않아야 하고, 동시에 모든 기기가 같은 색을 봐야 한다.
 * 그래서 랜덤이 아니라 결정적으로 배분한다.
 *
 *   1) 대원 id 를 정렬해 순서를 고정한다(모든 기기가 같은 순서를 얻는다).
 *   2) 각자 id 해시로 선호 색을 정하고, 이미 쓰인 색이면 다음 빈 색으로 넘어간다.
 *
 * 대원 수가 팔레트 길이를 넘으면 그때부터는 재사용이 불가피하다.
 *
 * window.RtlocPalette 로 노출된다.
 */
(function (global) {
  "use strict";

  // 어두운 지도 위에서 서로 확실히 구분되는 색들.
  var PALETTE = [
    "#4c9aff", "#35c58a", "#ffb020", "#ff5c5c",
    "#b57bff", "#00c2d1", "#ff8ac4", "#a3d13a",
    "#ff7a3d", "#6ee7ff", "#d4c04a", "#7f9cff",
    "#4fd18b", "#e0724f", "#c792ea", "#9fb4c7"
  ];

  function hashOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h;
  }

  /**
   * @param {string[]} ids 대원 id 목록
   * @returns {Object<string,string>} id -> 색상 (#rrggbb)
   */
  function assign(ids) {
    var sorted = ids.slice().sort();
    var taken = Object.create(null);
    var result = Object.create(null);

    sorted.forEach(function (id) {
      var preferred = hashOf(id) % PALETTE.length;
      var chosen = -1;

      for (var step = 0; step < PALETTE.length; step++) {
        var candidate = (preferred + step) % PALETTE.length;
        if (!taken[candidate]) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === -1) chosen = preferred; // 팔레트 초과분은 재사용

      taken[chosen] = true;
      result[id] = PALETTE[chosen];
    });

    return result;
  }

  /** 배분 전 임시 색(단독 표시용). 중복될 수 있다. */
  function preferredColor(id) {
    return PALETTE[hashOf(id) % PALETTE.length];
  }

  global.RtlocPalette = {
    PALETTE: PALETTE,
    assign: assign,
    preferredColor: preferredColor,
    hashOf: hashOf
  };
})(window);
