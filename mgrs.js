/**
 * WGS84 위경도 -> UTM -> MGRS(군사좌표) 변환.
 *
 * 군사좌표는 "52S CE 12345 67890" 형태다.
 *   52  UTM 경도대(zone)
 *   S   위도대(band)
 *   CE  100km 방격 식별자
 *   나머지  방격 안의 동거리/북거리 (자리수에 따라 정밀도 결정)
 *
 * 변환 공식은 USGS UTM 투영식(Snyder)과 표준 MGRS 100km 방격 규칙을 따른다.
 * 100km 방격 문자 배정은 공개된 표준 규칙(AA 방식, set origin 'AJSAJS'/'AFAFAF')을
 * 그대로 구현한 것이다.
 *
 * 주의: 극지방(위도 84°N 이상, 80°S 이하)은 UPS 좌표계를 쓰므로 지원하지 않는다.
 *
 * window.RtlocMgrs 로 노출된다.
 */
(function (global) {
  "use strict";

  var A = 6378137.0; // WGS84 장반경
  var ECC_SQUARED = 0.00669438;
  var K0 = 0.9996;

  var CHAR_A = 65, CHAR_I = 73, CHAR_O = 79, CHAR_V = 86, CHAR_Z = 90;
  var SET_ORIGIN_COLUMN_LETTERS = "AJSAJS";
  var SET_ORIGIN_ROW_LETTERS = "AFAFAF";

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  /** 위도대(band) 문자. 8도 간격이며 I, O 는 쓰지 않는다. */
  function bandLetter(lat) {
    if (lat > 84 || lat < -80) return null; // 극지방은 UPS 영역
    var bands = "CDEFGHJKLMNPQRSTUVWX";
    var index = Math.floor((lat + 80) / 8);
    if (index > 19) index = 19; // 72~84도는 X 대역(12도)
    return bands.charAt(index);
  }

  function zoneNumber(lat, lon) {
    var zone = Math.floor((lon + 180) / 6) + 1;
    if (lon === 180) zone = 60;

    // 노르웨이/스발바르 예외 구역
    if (lat >= 56.0 && lat < 64.0 && lon >= 3.0 && lon < 12.0) zone = 32;
    if (lat >= 72.0 && lat < 84.0) {
      if (lon >= 0.0 && lon < 9.0) zone = 31;
      else if (lon >= 9.0 && lon < 21.0) zone = 33;
      else if (lon >= 21.0 && lon < 33.0) zone = 35;
      else if (lon >= 33.0 && lon < 42.0) zone = 37;
    }
    return zone;
  }

  /** 위경도 -> UTM. { zone, band, easting, northing, hemisphere } */
  function toUtm(lat, lon) {
    // 경도를 -180~180 으로 정규화
    lon = ((lon + 180) % 360 + 360) % 360 - 180;

    var latRad = toRad(lat);
    var lonRad = toRad(lon);
    var zone = zoneNumber(lat, lon);
    var lonOrigin = (zone - 1) * 6 - 180 + 3;
    var lonOriginRad = toRad(lonOrigin);

    var eccPrimeSquared = ECC_SQUARED / (1 - ECC_SQUARED);
    var n = A / Math.sqrt(1 - ECC_SQUARED * Math.sin(latRad) * Math.sin(latRad));
    var t = Math.tan(latRad) * Math.tan(latRad);
    var c = eccPrimeSquared * Math.cos(latRad) * Math.cos(latRad);
    var a2 = Math.cos(latRad) * (lonRad - lonOriginRad);

    var m =
      A *
      ((1 - ECC_SQUARED / 4 - (3 * ECC_SQUARED * ECC_SQUARED) / 64 -
        (5 * Math.pow(ECC_SQUARED, 3)) / 256) * latRad -
        ((3 * ECC_SQUARED) / 8 + (3 * ECC_SQUARED * ECC_SQUARED) / 32 +
          (45 * Math.pow(ECC_SQUARED, 3)) / 1024) * Math.sin(2 * latRad) +
        ((15 * ECC_SQUARED * ECC_SQUARED) / 256 +
          (45 * Math.pow(ECC_SQUARED, 3)) / 1024) * Math.sin(4 * latRad) -
        ((35 * Math.pow(ECC_SQUARED, 3)) / 3072) * Math.sin(6 * latRad));

    var easting =
      K0 * n * (a2 + ((1 - t + c) * Math.pow(a2, 3)) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * eccPrimeSquared) * Math.pow(a2, 5)) / 120) +
      500000.0;

    var northing =
      K0 *
      (m + n * Math.tan(latRad) *
        ((a2 * a2) / 2 + ((5 - t + 9 * c + 4 * c * c) * Math.pow(a2, 4)) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * eccPrimeSquared) * Math.pow(a2, 6)) / 720));

    if (lat < 0) northing += 10000000.0;

    return {
      zone: zone,
      band: bandLetter(lat),
      easting: easting,
      northing: northing,
      hemisphere: lat < 0 ? "S" : "N"
    };
  }

  /** 경도대에 대응하는 100km 방격 세트 번호(1~6). */
  function setForZone(zone) {
    var set = zone % 6;
    return set === 0 ? 6 : set;
  }

  /** 100km 방격의 열/행 문자. I, O 를 건너뛰는 규칙이 핵심이다. */
  function letter100k(column, row, set) {
    var index = set - 1;
    var colOrigin = SET_ORIGIN_COLUMN_LETTERS.charCodeAt(index);
    var rowOrigin = SET_ORIGIN_ROW_LETTERS.charCodeAt(index);

    var colInt = colOrigin + column - 1;
    var rowInt = rowOrigin + row;
    var rollover = false;

    if (colInt > CHAR_Z) {
      colInt = colInt - CHAR_Z + CHAR_A - 1;
      rollover = true;
    }

    if (
      colInt === CHAR_I ||
      (colOrigin < CHAR_I && colInt > CHAR_I) ||
      ((colInt > CHAR_I || colOrigin < CHAR_I) && rollover)
    ) {
      colInt += 1;
    }

    if (
      colInt === CHAR_O ||
      (colOrigin < CHAR_O && colInt > CHAR_O) ||
      ((colInt > CHAR_O || colOrigin < CHAR_O) && rollover)
    ) {
      colInt += 1;
      if (colInt === CHAR_I) colInt += 1;
    }

    if (colInt > CHAR_Z) colInt = colInt - CHAR_Z + CHAR_A - 1;

    if (rowInt > CHAR_V) {
      rowInt = rowInt - CHAR_V + CHAR_A - 1;
      rollover = true;
    } else {
      rollover = false;
    }

    if (
      rowInt === CHAR_I ||
      (rowOrigin < CHAR_I && rowInt > CHAR_I) ||
      ((rowInt > CHAR_I || rowOrigin < CHAR_I) && rollover)
    ) {
      rowInt += 1;
    }

    if (
      rowInt === CHAR_O ||
      (rowOrigin < CHAR_O && rowInt > CHAR_O) ||
      ((rowInt > CHAR_O || rowOrigin < CHAR_O) && rollover)
    ) {
      rowInt += 1;
      if (rowInt === CHAR_I) rowInt += 1;
    }

    if (rowInt > CHAR_V) rowInt = rowInt - CHAR_V + CHAR_A - 1;

    return String.fromCharCode(colInt) + String.fromCharCode(rowInt);
  }

  /**
   * 위경도 -> MGRS 문자열.
   * @param {number} accuracyDigits 방격 내 자리수 (5 = 1m, 4 = 10m, 3 = 100m)
   * @param {boolean} spaced 사람이 읽기 쉽게 공백으로 끊을지
   */
  function toMgrs(lat, lon, accuracyDigits, spaced) {
    var digits = accuracyDigits == null ? 5 : accuracyDigits;
    if (digits < 1 || digits > 5) digits = 5;

    var utm = toUtm(lat, lon);
    if (!utm.band) return null; // 극지방

    var set = setForZone(utm.zone);
    var column = Math.floor(utm.easting / 100000);
    var row = Math.floor(utm.northing / 100000) % 20;
    var square = letter100k(column, row, set);

    // 방격 내 좌표를 요청 자리수로 자른다(반올림이 아니라 버림: 격자 규칙)
    var divisor = Math.pow(10, 5 - digits);
    var east = Math.floor((utm.easting % 100000) / divisor);
    var north = Math.floor((utm.northing % 100000) / divisor);

    var eastStr = String(east).padStart(digits, "0");
    var northStr = String(north).padStart(digits, "0");

    var zonePart = String(utm.zone) + utm.band;
    return spaced
      ? zonePart + " " + square + " " + eastStr + " " + northStr
      : zonePart + square + eastStr + northStr;
  }

  /** 도분초 표기. 예: 37°33'59.4"N */
  function toDms(value, isLat) {
    var hemisphere = value < 0 ? (isLat ? "S" : "W") : isLat ? "N" : "E";
    var abs = Math.abs(value);
    var deg = Math.floor(abs);
    var minFloat = (abs - deg) * 60;
    var min = Math.floor(minFloat);
    var sec = (minFloat - min) * 60;
    return deg + "°" + String(min).padStart(2, "0") + "'" + sec.toFixed(1) + '"' + hemisphere;
  }

  global.RtlocMgrs = {
    toUtm: toUtm,
    toMgrs: toMgrs,
    toDms: toDms,
    bandLetter: bandLetter,
    zoneNumber: zoneNumber
  };
})(window);
