/**
 * 임무 기록과 저장.
 *
 *  - Recorder: 임무 시작~종료 사이의 대원별 이동 경로를 모은다.
 *  - Storage:  완료된 임무를 이 기기의 localStorage 에 팀별로 저장한다.
 *
 * 저장은 기기 로컬에만 이뤄진다. 경로 기록은 팀 위치와 같은 민감 정보이므로
 * 서버나 브로커로 올려 보관하지 않는다.
 *
 * window.RtlocMission 으로 노출된다.
 */
(function (global) {
  "use strict";

  var STORAGE_PREFIX = "rtloc.missions.";
  var MAX_POINTS_PER_MEMBER = 4000; // 대원 1명당 상한 (약 2시간 이상 분량)
  var MIN_POINT_DISTANCE = 5; // m. 이보다 덜 움직였으면 새 점을 찍지 않는다
  var MIN_POINT_INTERVAL = 4000; // ms. 정지 상태에서도 이 주기로는 점을 남긴다
  var MAX_STORED_MISSIONS = 50;

  // ---------- 기록기 ----------

  /**
   * @param {{missionId?: string, startedAt?: number, teamName: string, teamKey: string}} opts
   */
  function createRecorder(opts) {
    return {
      missionId: opts.missionId || newId(),
      teamName: opts.teamName,
      teamKey: opts.teamKey,
      startedAt: opts.startedAt || Date.now(),
      endedAt: null,
      tracks: Object.create(null), // memberId -> { id, name, points: [[lat, lng, ts]] }
      truncated: false,

      /**
       * 위치를 경로에 추가한다.
       * @returns {boolean} 실제로 점이 추가되었는지 (경로선 갱신 여부 판단용)
       */
      addPoint: function (memberId, name, lat, lng, ts) {
        var track = this.tracks[memberId];
        if (!track) {
          track = this.tracks[memberId] = { id: memberId, name: name, points: [] };
        }
        track.name = name || track.name;

        var points = track.points;
        var last = points[points.length - 1];

        if (last) {
          var movedEnough = haversine(last[0], last[1], lat, lng) >= MIN_POINT_DISTANCE;
          var waitedEnough = ts - last[2] >= MIN_POINT_INTERVAL;
          if (!movedEnough && !waitedEnough) return false;
        }

        if (points.length >= MAX_POINTS_PER_MEMBER) {
          // 상한에 닿으면 오래된 점을 절반으로 솎아내고 계속 기록한다.
          track.points = points.filter(function (_, i) {
            return i % 2 === 0;
          });
          this.truncated = true;
          points = track.points;
        }

        points.push([round6(lat), round6(lng), ts]);
        return true;
      },

      trackOf: function (memberId) {
        return this.tracks[memberId] || null;
      },

      /** 저장/요약용 평문 객체로 변환한다. */
      finish: function (extra) {
        this.endedAt = this.endedAt || Date.now();

        var tracks = Object.keys(this.tracks).map(
          function (id) {
            var t = this.tracks[id];
            return {
              id: t.id,
              name: t.name,
              color: (extra && extra.colors && extra.colors[t.id]) || null,
              points: t.points,
              distance: trackDistance(t.points)
            };
          }.bind(this)
        );

        tracks.sort(function (a, b) {
          return String(a.name).localeCompare(String(b.name), "ko");
        });

        return {
          id: this.missionId,
          name: (extra && extra.name) || "",
          teamName: this.teamName,
          teamKey: this.teamKey,
          startedAt: this.startedAt,
          endedAt: this.endedAt,
          truncated: this.truncated,
          tracks: tracks
        };
      }
    };
  }

  // ---------- 요약 ----------

  function summarize(mission) {
    var totalDistance = 0;
    var pointCount = 0;

    mission.tracks.forEach(function (t) {
      totalDistance += t.distance || trackDistance(t.points);
      pointCount += t.points.length;
    });

    return {
      memberCount: mission.tracks.length,
      totalDistance: totalDistance,
      pointCount: pointCount,
      durationMs: Math.max(0, (mission.endedAt || 0) - (mission.startedAt || 0))
    };
  }

  /** 모든 경로를 감싸는 [[남, 서], [북, 동]] 경계. 점이 없으면 null. */
  function boundsOf(mission) {
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, seen = false;

    mission.tracks.forEach(function (t) {
      t.points.forEach(function (p) {
        seen = true;
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLng) minLng = p[1];
        if (p[1] > maxLng) maxLng = p[1];
      });
    });

    return seen ? [[minLat, minLng], [maxLat, maxLng]] : null;
  }

  // ---------- 저장소 ----------

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

  function save(teamKey, mission) {
    var missions = list(teamKey);

    // 같은 임무를 다시 저장하면 덮어쓴다.
    missions = missions.filter(function (m) {
      return m.id !== mission.id;
    });
    missions.unshift(mission);
    if (missions.length > MAX_STORED_MISSIONS) missions = missions.slice(0, MAX_STORED_MISSIONS);

    try {
      localStorage.setItem(storageKey(teamKey), JSON.stringify(missions));
      return { ok: true, count: missions.length };
    } catch (e) {
      // 용량 초과. 가장 오래된 임무를 지워 가며 재시도한다.
      var trimmed = missions.slice();
      while (trimmed.length > 1) {
        trimmed.pop();
        try {
          localStorage.setItem(storageKey(teamKey), JSON.stringify(trimmed));
          return { ok: true, count: trimmed.length, evicted: missions.length - trimmed.length };
        } catch (e2) {
          /* 계속 줄인다 */
        }
      }
      return { ok: false, error: "저장 공간이 부족합니다. 기존 기록을 지우고 다시 시도해 주세요." };
    }
  }

  function remove(teamKey, missionId) {
    var missions = list(teamKey).filter(function (m) {
      return m.id !== missionId;
    });
    try {
      localStorage.setItem(storageKey(teamKey), JSON.stringify(missions));
      return true;
    } catch (e) {
      return false;
    }
  }

  function get(teamKey, missionId) {
    var found = null;
    list(teamKey).forEach(function (m) {
      if (m.id === missionId) found = m;
    });
    return found;
  }

  // ---------- 내보내기 ----------

  /** 지도 도구에서 바로 열 수 있는 GeoJSON 으로 변환한다. */
  function toGeoJson(mission) {
    var features = mission.tracks.map(function (t) {
      return {
        type: "Feature",
        properties: {
          name: t.name,
          memberId: t.id,
          color: t.color,
          distanceMeters: Math.round(t.distance || trackDistance(t.points)),
          startedAt: t.points.length ? new Date(t.points[0][2]).toISOString() : null,
          endedAt: t.points.length ? new Date(t.points[t.points.length - 1][2]).toISOString() : null
        },
        geometry: {
          type: "LineString",
          coordinates: t.points.map(function (p) {
            return [p[1], p[0]]; // GeoJSON 은 [경도, 위도]
          })
        }
      };
    });

    return {
      type: "FeatureCollection",
      properties: {
        mission: mission.name,
        team: mission.teamName,
        startedAt: new Date(mission.startedAt).toISOString(),
        endedAt: new Date(mission.endedAt).toISOString()
      },
      features: features
    };
  }

  // ---------- 유틸 ----------

  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLng = ((lng2 - lng1) * Math.PI) / 180;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function trackDistance(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) {
      total += haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    }
    return total;
  }

  function round6(n) {
    return Math.round(n * 1e6) / 1e6;
  }

  function newId() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  global.RtlocMission = {
    MIN_POINT_DISTANCE: MIN_POINT_DISTANCE,
    createRecorder: createRecorder,
    summarize: summarize,
    boundsOf: boundsOf,
    trackDistance: trackDistance,
    toGeoJson: toGeoJson,
    newId: newId,
    storage: { list: list, save: save, remove: remove, get: get }
  };
})(window);
