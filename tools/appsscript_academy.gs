/**
 * 학습관리 앱 — 구글시트 백엔드 (Google Apps Script)
 *
 * 앱(localStorage)이 1차 저장소이고, 이 스크립트는 백업/동기화 계층이다.
 * 이게 죽어도 앱은 정상 동작해야 한다.
 *
 * 저장(POST): 앱이 mode:'no-cors' + text/plain 으로 보낸다(preflight 회피).
 *             응답은 앱이 읽지 못한다 — fire-and-forget.
 *             그래서 모든 행에 클라이언트가 만든 rid 가 있고, 업서트다.
 *             재전송이 중복 행을 만들지 않는 것이 이 설계의 핵심이다.
 * 조회(GET) : JSONP. Apps Script 가 googleusercontent.com 으로 리다이렉트하며
 *             CORS 가 깨지므로 fetch 로는 못 읽는다. callback= 파라미터로 감싸 보낸다.
 *
 * ⚠ 배포 시 "액세스 권한: 모든 사용자" 여야 한다. 아니면 POST 가 405 로 실패한다.
 *
 * ── 격리 ─────────────────────────────────────────────────────────────
 * 아이 / 부모 / 선생이 서로의 것을 못 본다. 그 판정을 **여기서** 한다.
 * 클라이언트에서 숨기는 것은 격리가 아니다 — 개발자도구를 열면 다 보인다.
 * doGet 은 그 역할이 읽을 수 있는 시트만 **애초에 조회조차 하지 않는다.**
 * 아이 세션의 응답 payload 에는 피드백·성적 키 자체가 존재하지 않는다.
 */

var SCRIPT_VERSION = '2026-08-26a';
var CFG_SHEET = 'settings';
var CODE_FALLBACK = '';        // 비워둔다. settings B1 을 못 읽으면 아무도 통과 못 한다.

/* ══════════════════════════════════════════════════════════════════════
 * 시트 스키마
 *
 * 모든 표가 앞 3열을 공유한다:  rid | 수정시각 | 삭제
 *   rid      클라이언트가 만든 고유 id. 업서트 키.
 *            no-cors 라 앱은 저장 성공 여부를 모른다 → 불확실하면 다시 보낸다.
 *            rid 가 없으면 그 재전송이 전부 중복 행이 된다.
 *   수정시각  마지막으로 쓴 시각(ms). 역전 방지에 쓴다.
 *   삭제      1 이면 묘비. **행을 지우지 않는다** — 아래 주석 참조.
 *
 * ⚠ 어느 표에서도 행을 물리적으로 삭제하지 않는다.
 *   학원을 지우면 3개월치 학습기록·피드백·성적의 학원rid 가 전부 고아가 된다.
 *   과거 기록이 "무슨 학원이었는지 모르는 기록"으로 변한다.
 * ══════════════════════════════════════════════════════════════════════ */

var BASE = ['rid', '수정시각', '삭제'];

var TABLES = {
  '학원':     BASE.concat(['이름', '과목', '색', '상태', '시작일', '종료일', '메모']),
  '일정':     BASE.concat(['학원rid', '요일', '시작', '종료', '유효시작일', '유효종료일']),
  '과제':     BASE.concat(['학원rid', '등록일', '마감일', '내용', '분량', '상태', '완료일', '작성자']),
  '학습기록': BASE.concat(['날짜', '시각', '과목', '학원rid', '내용', '소요분', '작성자']),
  '피드백':   BASE.concat(['날짜', '학원rid', '경로', '원문', '태그', '감성', '입력자', '확인']),
  '성적':     BASE.concat(['날짜', '학원rid', '시험명', '점수', '만점', '등수', '응시인원', '백분율']),
  '목표':     BASE.concat(['연월', '항목', '목표내용', '지표', '목표값', '현재값', '비고'])
};

/* ── 권한 ──────────────────────────────────────────────────────────────
 * 역할은 child(아이) / parent(부모) / teacher(선생) 셋.
 *
 * 보호선은 **하나뿐이다: 아이는 자기에 대한 어른들의 기록을 못 본다.**
 *   피드백·성적  어른이 쓰고 어른이 본다. 아이는 차단.
 * 그 외에는 부모와 선생이 같은 것을 본다 — 둘 다 아이를 같이 관리하는 쪽이다.
 *
 *   학습기록  아이가 쓰고, 부모·선생이 읽는다 (고치지는 못한다. 아이 것이다)
 *   목표      어른이 쓰고 아이는 읽는다 (아이 화면 상단에 뜬다)
 */
var PERM = {
  '학원':     { r: ['child', 'parent', 'teacher'], w: ['parent', 'teacher'] },
  '일정':     { r: ['child', 'parent', 'teacher'], w: ['parent', 'teacher'] },
  '과제':     { r: ['child', 'parent', 'teacher'], w: ['child', 'parent', 'teacher'] },
  '학습기록': { r: ['child', 'parent', 'teacher'], w: ['child', 'teacher'] },
  '피드백':   { r: ['parent', 'teacher'],          w: ['parent', 'teacher'] },
  '성적':     { r: ['parent', 'teacher'],          w: ['parent', 'teacher'] },
  '목표':     { r: ['child', 'parent', 'teacher'], w: ['parent', 'teacher'] }
};

function canRead_(t, role)  { return !!(PERM[t] && PERM[t].r.indexOf(role) >= 0); }
function canWrite_(t, role) { return !!(PERM[t] && PERM[t].w.indexOf(role) >= 0); }

/* ══════════════════════════════════════════════════════════════════════
 * settings 시트
 *
 *   B1        공용코드            ← 1차 관문
 *   B2        명단 사용  끔|켬     ← 안전 스위치
 *   A5/B5/C5  헤더  이름 | 역할 | 개인코드
 *   A6~       명단 데이터
 *
 * 개인코드가 역할을 결정한다. 그래서 이 앱은 명단이 **반드시 켜져 있어야** 한다.
 * 명단이 꺼져 있으면 역할을 알 수 없으므로 아무도 통과시키지 않는다
 * (CPX 와 다른 점이다. 거기선 명단이 부가 기능이었지만 여기선 격리의 근거다).
 * ══════════════════════════════════════════════════════════════════════ */

var ROSTER_SW_ROW  = 2;
var ROSTER_HDR_ROW = 5;
var ROSTER_TOP     = 6;

/** 이름 비교용 정규화 — 앞뒤 공백을 없애고 중간 공백을 하나로 줄인다. */
function norm_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim();
}

/** 역할 문자열을 표준화한다. 시트에 한글로 적을 수 있게. */
function role_(v) {
  var s = norm_(v).toLowerCase();
  if (s === '아이' || s === '학생' || s === 'child' || s === 'student') return 'child';
  if (s === '부모' || s === '학부모' || s === 'parent') return 'parent';
  if (s === '선생' || s === '선생님' || s === '과외' || s === 'teacher') return 'teacher';
  return '';
}

function getCode_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('tp_code');
  if (hit !== null && hit !== undefined) return hit;
  var code = '';
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG_SHEET);
    if (sh) code = String(sh.getRange('B1').getValue() || '').trim();
  } catch (e) { /* 무시 */ }
  if (!code) code = CODE_FALLBACK;
  cache.put('tp_code', code, 30);
  return code;
}

/** 명단을 읽는다. {on, map:{정규화이름:{role,code}}, n}. 30초 캐시. */
function getRoster_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('tp_roster');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 깨졌으면 다시 읽는다 */ } }
  var r = { on: false, map: {}, n: 0 };
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG_SHEET);
    if (sh) {
      var sw = String(sh.getRange(ROSTER_SW_ROW, 2).getValue() || '').trim();
      r.on = (sw === '켬' || sw.toLowerCase() === 'on');
      var maxR = sh.getLastRow();                   // getMaxRows() 아니다. 3명 읽자고 1000행 읽지 않는다
      if (maxR >= ROSTER_TOP) {
        var vals = sh.getRange(ROSTER_TOP, 1, maxR - ROSTER_TOP + 1, 3).getValues();
        for (var i = 0; i < vals.length; i++) {
          var nm = norm_(vals[i][0]);
          if (!nm) continue;
          if (!r.map.hasOwnProperty(nm)) r.n++;
          r.map[nm] = { role: role_(vals[i][1]), code: norm_(vals[i][2]) };
        }
      }
    }
  } catch (e) {
    r = { on: false, map: {}, n: 0 };
  }
  cache.put('tp_roster', JSON.stringify(r), 30);
  return r;
}

/**
 * 입장 판정. 모든 요청이 여기 한 곳을 지난다.
 *
 * ⚠ CPX 와 정반대로 **fail-closed** 다.
 *   CPX 는 명단을 못 읽으면 공용코드로 떨어졌다(fail-open). 거기선 명단이 부가 기능이라
 *   일시적 읽기 실패로 전원이 잠기는 게 더 나빴다.
 *   여기서는 명단이 **역할의 유일한 근거**다. 역할을 모르는 채 통과시키면
 *   아이가 부모 데이터를 받아갈 수 있다. 못 읽으면 막는 쪽이 맞다.
 */
function authOK_(name, code) {
  var shared = getCode_();
  code = norm_(code);
  if (!shared) return { ok: false, err: 'no shared code' };   // B1 이 비었다 = 설치 안 됨
  var r = getRoster_();
  if (!r.on || r.n === 0) return { ok: false, err: 'roster off' };
  var nm = norm_(name);
  if (!nm || !r.map.hasOwnProperty(nm)) return { ok: false, err: 'not allowed' };
  var ent = r.map[nm];
  if (!ent.role) return { ok: false, err: 'no role' };         // 역할 칸이 비었다
  var want = ent.code || shared;
  if (code !== want) return { ok: false, err: 'bad code' };
  return { ok: true, role: ent.role, name: nm };
}

/* ══════════════════════════════════════════════════════════════════════ */

var SETUP_KEY = 'tp_setup_2026_08_26a';

/**
 * 시트 7개 + settings 를 만든다.
 *
 * ⚠ 이 함수는 모든 GET/POST 가 맨 앞에서 부른다. 설치가 끝났으면 **즉시 나간다.**
 *   CPX 에서는 이 자리에서 요청마다 서식 쓰기가 2회 나갔고(그중 하나는 최대행 전체),
 *   그게 doPost 에서 락을 잡은 채 벌어져 락 보유 시간을 그대로 늘렸다.
 *   다시 돌리려면 tpSetup() 을 실행한다(force=true).
 */
function ensure_(force) {
  if (!force) {
    try {
      if (PropertiesService.getScriptProperties().getProperty(SETUP_KEY) === '1') return;
    } catch (e) { /* 못 읽으면 아래로 떨어져 한 번 더 설치한다 */ }
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var cfg = ss.getSheetByName(CFG_SHEET);
  if (!cfg) {
    cfg = ss.insertSheet(CFG_SHEET);
    cfg.getRange('A1').setValue('공용코드');
    cfg.getRange('C1').setValue('← 여기를 고치면 30초 안에 반영됩니다. 재배포 불필요. config.json 의 code 와 맞추세요.');
    cfg.setColumnWidth(1, 120);
    cfg.setColumnWidth(2, 200);
    cfg.setColumnWidth(3, 520);
  }
  if (!String(cfg.getRange(ROSTER_SW_ROW, 1).getValue() || '').trim()) {
    cfg.getRange(ROSTER_SW_ROW, 1).setValue('명단 사용');
    cfg.getRange(ROSTER_SW_ROW, 2).setValue('끔');
    cfg.getRange(ROSTER_SW_ROW, 3)
       .setValue('← 이 앱은 "켬" 이어야 동작합니다. 개인코드가 역할을 결정하기 때문입니다.');
    cfg.getRange(3, 3).setValue('※ 역할 칸에는 아이 / 부모 / 선생 중 하나를 적습니다.');
    cfg.getRange(4, 3).setValue('※ 개인코드를 비우면 공용코드로 통과합니다. 격리하려면 셋 다 다르게 주세요.');
  }
  if (!String(cfg.getRange(ROSTER_HDR_ROW, 1).getValue() || '').trim()) {
    cfg.getRange(ROSTER_HDR_ROW, 1, 1, 3).setValues([['이름', '역할', '개인코드']])
       .setFontWeight('bold');
  }
  /* 이름·역할·개인코드 열은 텍스트 서식으로 고정한다.
     안 그러면 시트가 '5/6' 같은 코드를 날짜로 바꾼다. */
  try {
    var mx = cfg.getMaxRows();
    if (mx >= ROSTER_TOP) cfg.getRange(ROSTER_TOP, 1, mx - ROSTER_TOP + 1, 3).setNumberFormat('@');
    cfg.getRange(1, 2, ROSTER_SW_ROW, 1).setNumberFormat('@');
  } catch (e) { /* 서식 실패는 치명적이지 않다 */ }

  for (var t in TABLES) {
    if (!TABLES.hasOwnProperty(t)) continue;
    var sh = ss.getSheetByName(t);
    var hdr = TABLES[t];
    if (!sh) {
      sh = ss.insertSheet(t);
      sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 130);
      sh.setColumnWidth(2, 130);
      sh.setColumnWidth(3, 50);
    } else {
      // 열이 늘어난 경우 헤더만 채운다. 기존 열은 절대 건드리지 않는다.
      var last = sh.getLastColumn();
      for (var c = last + 1; c <= hdr.length; c++) {
        if (!String(sh.getRange(1, c).getValue() || '').trim()) sh.getRange(1, c).setValue(hdr[c - 1]);
      }
    }
    /* 값 열 전체를 텍스트 서식으로 고정한다.
       "쎈 5/6" 같은 학습 내용이 날짜로, "3-1" 이 수식으로 변하는 것을 막는다.
       열 단위로 미리 해두면 doPost 가 요청마다 setNumberFormat 을 돌 필요가 없다. */
    try {
      sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), hdr.length).setNumberFormat('@');
    } catch (e2) { /* 무시 */ }
  }
  SpreadsheetApp.flush();
  try { PropertiesService.getScriptProperties().setProperty(SETUP_KEY, '1'); } catch (e3) {}
}

function sheet_(t) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(t);
  if (!sh) {
    sh = ss.insertSheet(t);
    sh.getRange(1, 1, 1, TABLES[t].length).setValues([TABLES[t]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function tsNum_(v) {
  var n = Number(v);
  return (v === '' || v === null || v === undefined || isNaN(n)) ? 0 : n;
}

/** 클라이언트가 보낸 ts 를 도장으로 쓸지 판정. 없으면/깨졌으면/미래면 서버 시각.
 *  오프라인 큐에 며칠 묵은 값이 나중에 도착해도 "도착 시각"이 아니라
 *  "원래 저장한 시각"으로 남아야 한다. */
function stamp_(ts, nowMs) {
  var t = (typeof ts === 'number' && isFinite(ts) && ts > 0) ? ts : nowMs;
  if (t > nowMs + 5 * 60 * 1000) t = nowMs;
  return t;
}

/* ══════════════════════════════════════════════════════════════════════
 * 저장
 *
 * 봉투: {code, name, ops:[{t:표이름, rid:..., ts:..., del:0|1, d:{열이름:값}} …]}
 * 표가 섞여 들어와도 된다. 락 하나로 전부 처리한다.
 * ══════════════════════════════════════════════════════════════════════ */
function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    /* ⚠ 파싱·인증은 락 **밖에서** 한다. 데이터 시트를 건드리지 않는 일이라
       락 안에 두면 남의 저장까지 기다리게 만든다. */
    var d = JSON.parse(e.postData.contents);
    ensure_();
    var au = authOK_(d.name, d.code);
    if (!au.ok) return out_({ ok: false, err: au.err, v: SCRIPT_VERSION });

    var ops = Array.isArray(d.ops) ? d.ops : [];
    if (!ops.length) return out_({ ok: true, n: 0, v: SCRIPT_VERSION });

    // 표별로 모은다 — 시트를 한 번씩만 읽고 쓰기 위해서다
    var byT = {}, denied = 0;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || !op.t || !op.rid || !TABLES[op.t]) { denied++; continue; }
      if (!canWrite_(op.t, au.role)) { denied++; continue; }   // ← 서버측 쓰기 차단
      if (!byT[op.t]) byT[op.t] = [];
      byT[op.t].push(op);
    }

    /* 락 대기 25초. 구버전을 캐시한 기기가 청크를 동시에 던지면 10초로는
       뒤 청크가 락을 못 잡고 통째로 버려진다 — no-cors 라 그쪽은 실패를 알지도 못한다.
       조용한 유실보다 기다리게 하는 편이 훨씬 낫다. */
    lock.waitLock(25000);
    locked = true;

    var nowMs = new Date().getTime();
    var res = { ok: true, v: SCRIPT_VERSION, n: 0, denied: denied, stale: 0, added: 0, tables: {} };

    for (var t in byT) {
      if (!byT.hasOwnProperty(t)) continue;
      var r = writeTable_(t, byT[t], au.name, nowMs);
      res.n += r.n; res.stale += r.stale; res.added += r.added;
      res.tables[t] = r.n;
    }
    return out_(res);
  } catch (err) {
    return out_({ ok: false, err: String(err), v: SCRIPT_VERSION });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

/** 한 표에 대해 업서트한다. rid 가 키. */
function writeTable_(t, ops, who, nowMs) {
  var hdr = TABLES[t];
  var sh = sheet_(t);
  var lastRow = sh.getLastRow();
  var vals = (lastRow >= 1)
    ? sh.getRange(1, 1, lastRow, hdr.length).getValues()
    : [hdr.slice()];

  var idx = {};                                   // rid → vals 인덱스(=행-1)
  for (var i = 1; i < vals.length; i++) {
    var k = String(vals[i][0] || '');
    if (k) idx[k] = i;
  }

  var col = {};                                   // 열이름 → 인덱스
  for (var c = 0; c < hdr.length; c++) col[hdr[c]] = c;

  var touched = {}, appends = [], newIdx = {}, n = 0, stale = 0;

  for (var j = 0; j < ops.length; j++) {
    var op = ops[j];
    var rid = String(op.rid);
    var st = stamp_(op.ts, nowMs);

    var at = (idx[rid] !== undefined) ? idx[rid] : -1;
    var ai = (at < 0 && newIdx[rid] !== undefined) ? newIdx[rid] : -1;
    var prev = (at >= 0) ? vals[at] : (ai >= 0 ? appends[ai] : null);

    /* ⚠ 역전 방지. 시트 쪽 수정시각이 더 최신이면 버린다.
       오프라인 큐에 며칠 묵은 값이 뒤늦게 도착해도, 그 사이 다른 기기가 저장한
       더 최신 값을 덮지 못한다. */
    if (prev && tsNum_(prev[1]) > st) { stale++; continue; }

    var row;
    if (prev) {
      row = prev.slice();
    } else {
      row = [];
      for (var z = 0; z < hdr.length; z++) row.push('');
      row[0] = rid;
    }
    row[1] = st;
    row[2] = op.del ? 1 : '';

    // 보낸 열만 갱신한다. 안 보낸 열은 기존 값 그대로.
    var dd = op.d || {};
    for (var key in dd) {
      if (!dd.hasOwnProperty(key)) continue;
      if (col[key] === undefined || col[key] < 3) continue;   // rid/수정시각/삭제는 위에서 다뤘다
      var v = dd[key];
      row[col[key]] = (v === null || v === undefined) ? ''
                    : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    /* 작성자/입력자는 **만든 사람**이다. 클라이언트 말을 믿지 않고 봉투의 이름을 쓰되,
       기존 행에는 다시 쓰지 않는다 — 선생이 낸 과제를 아이가 완료 체크했다고
       작성자가 아이로 바뀌면, 누가 냈는지의 원 기록이 사라진다. */
    if (!prev) {
      if (col['작성자'] !== undefined) row[col['작성자']] = who;
      if (col['입력자'] !== undefined) row[col['입력자']] = who;
    }

    if (at >= 0)      { vals[at] = row; touched[at] = true; }
    else if (ai >= 0) { appends[ai] = row; }
    else              { newIdx[rid] = appends.length; appends.push(row); }
    n++;
  }

  /* ── 기존 행 쓰기 ────────────────────────────────────────────────
     행마다 setValues 를 부르면 왕복이 그 수만큼 나가고 그동안 락을 붙잡는다.
     → 행 번호를 정렬해 **연속 구간끼리 묶어** 한 번에 쓴다.
     ⚠ 떨어져 있는 구간을 억지로 합치지는 않는다. 사이에 낀 남의 행까지 다시 쓰게 된다. */
  var rowsIdx = [];
  for (var k2 in touched) { if (touched.hasOwnProperty(k2)) rowsIdx.push(Number(k2)); }
  rowsIdx.sort(function (x, y) { return x - y; });
  var bi = 0;
  while (bi < rowsIdx.length) {
    var bj = bi;
    while (bj + 1 < rowsIdx.length && rowsIdx[bj + 1] === rowsIdx[bj] + 1) bj++;
    var block = [];
    for (var q = bi; q <= bj; q++) block.push(vals[rowsIdx[q]]);
    sh.getRange(rowsIdx[bi] + 1, 1, block.length, hdr.length).setValues(block);
    bi = bj + 1;
  }

  /* ── 새 행 붙이기 ────────────────────────────────────────────────
     ⚠ 필요한 행 수를 **먼저 확보**한다. 시트 최대 행에 닿으면 getRange 가 범위 밖
       예외를 던지고 그 청크 전체가 조용히 사라진다. CPX 에서 실제로 겪은 일이다. */
  if (appends.length) {
    var at2 = sh.getLastRow() + 1;
    var need = at2 + appends.length - 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 20);
    sh.getRange(at2, 1, appends.length, hdr.length).setNumberFormat('@');
    SpreadsheetApp.flush();                       // 서식을 값보다 먼저 확정시킨다
    sh.getRange(at2, 1, appends.length, hdr.length).setValues(appends);
  }
  return { n: n, stale: stale, added: appends.length };
}

/* ══════════════════════════════════════════════════════════════════════
 * 조회 — 역할이 읽을 수 있는 표만. JSONP.
 *
 * 응답에는 항상 now(서버 시각)를 싣는다. 클라이언트가 이걸로 자기 시계 오차를
 * 보정해 앞으로 찍을 ts 를 서버 시각 기준으로 맞춘다. 실패 응답에도 싣는다.
 * ══════════════════════════════════════════════════════════════════════ */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var payload;
  try {
    ensure_();
    var au = authOK_(p.name, p.code);
    if (!au.ok) {
      payload = { ok: false, err: au.err };
    } else if (p.probe) {
      /* 게이트의 입장 확인용. 시트를 통째로 읽지 않고 판정만 돌려준다 —
         거부든 승인이든 비싼 getDataRange() 를 안 탄다. */
      payload = { ok: true, probe: 1, role: au.role };
    } else {
      var data = {};
      for (var t in TABLES) {
        if (!TABLES.hasOwnProperty(t)) continue;
        if (!canRead_(t, au.role)) continue;       // ← 읽을 수 없으면 시트를 열지도 않는다
        data[t] = readTable_(t);
      }
      payload = { ok: true, role: au.role, data: data };
    }
  } catch (err) {
    payload = { ok: false, err: String(err) };
  }
  payload.now = new Date().getTime();
  payload.v = SCRIPT_VERSION;
  var json = JSON.stringify(payload);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/** 한 표를 {rid: {열이름:값}} 으로 읽는다. 묘비 행도 준다(클라이언트가 병합해야 하므로). */
function readTable_(t) {
  var hdr = TABLES[t];
  var sh = sheet_(t);
  var lastRow = sh.getLastRow();
  var o = {};
  if (lastRow < 2) return o;
  var vals = sh.getRange(2, 1, lastRow - 1, hdr.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var rid = String(vals[i][0] || '').trim();
    if (!rid) continue;
    var row = { rid: rid, _ts: tsNum_(vals[i][1]), _del: vals[i][2] ? 1 : 0 };
    for (var c = 3; c < hdr.length; c++) row[hdr[c]] = vals[i][c];
    o[rid] = row;
  }
  return o;
}

/* ══════════════════════════════════════════════════════════════════════
 * 운영용 — Apps Script 편집기의 실행(▶) 목록에서 직접 돌린다.
 * 이름 끝에 _ 를 안 붙인 이유가 이것이다.
 * ══════════════════════════════════════════════════════════════════════ */

/** 설치 — 재배포 직후 편집기에서 한 번 실행한다. 값은 한 글자도 건드리지 않는다. */
function tpSetup() {
  ensure_(true);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lines = ['tpSetup ' + SCRIPT_VERSION];
  for (var t in TABLES) {
    if (!TABLES.hasOwnProperty(t)) continue;
    var sh = ss.getSheetByName(t);
    lines.push('  ' + t + ' : ' + (sh.getLastRow() - 1) + '행 / 최대 ' + sh.getMaxRows());
  }
  var r = getRoster_();
  lines.push('  명단 : ' + (r.on ? '켬' : '끔') + ' · ' + r.n + '명');
  var msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

/** 라이브에 무엇이 올라가 있는지 확인용 */
function tpVersion() {
  var setup = '';
  try { setup = PropertiesService.getScriptProperties().getProperty(SETUP_KEY) || '(없음)'; }
  catch (e) { setup = '(못읽음)'; }
  Logger.log('version=' + SCRIPT_VERSION + ' setupFlag=' + setup);
  return SCRIPT_VERSION + ' / setup=' + setup;
}

/**
 * 명단 점검 — 켜기 전에 반드시 돌린다. 아무것도 바꾸지 않는다.
 * 역할이 비었거나 개인코드가 겹치면 격리가 깨진다. 그걸 잡아낸다.
 */
function tpRosterAudit() {
  var r = getRoster_();
  var shared = getCode_();
  var byCode = {}, problems = [], names = [];
  for (var nm in r.map) {
    if (!r.map.hasOwnProperty(nm)) continue;
    var ent = r.map[nm];
    names.push(nm + '(' + (ent.role || '⚠역할없음') + ')');
    if (!ent.role) problems.push(nm + ' : 역할 칸이 비었습니다 — 로그인이 막힙니다');
    var c = ent.code || shared;
    if (byCode[c]) {
      problems.push('⚠ ' + nm + ' 와 ' + byCode[c] + ' 의 코드가 같습니다 — 서로의 데이터가 보입니다');
    } else byCode[c] = nm;
    if (!ent.code) problems.push('⚠ ' + nm + ' 은 개인코드가 비어 공용코드로 통과합니다 — 격리가 안 됩니다');
  }
  Logger.log('공용코드 : ' + (shared ? '설정됨' : '⚠ 비어 있음 — 아무도 로그인 못 합니다'));
  Logger.log('명단 : ' + (r.on ? '켬' : '⚠ 끔 — 이 앱은 켜야 동작합니다') + ' · ' + r.n + '명');
  Logger.log('등재 : ' + (names.length ? names.join(', ') : '(없음)'));
  if (problems.length) {
    Logger.log('── 문제 ──');
    for (var i = 0; i < problems.length; i++) Logger.log('  ' + problems[i]);
  } else {
    Logger.log('문제 없음. 세 사람의 코드가 모두 다르고 역할이 채워져 있습니다.');
  }
  return { on: r.on, n: r.n, problems: problems };
}

/** 명단 초기값을 넣는다. 이름·코드를 고쳐서 한 번 실행하면 된다. 이미 있는 이름은 안 건드린다. */
function tpRosterInit() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG_SHEET);
  if (!sh) { ensure_(true); sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG_SHEET); }
  var want = [
    ['아이이름',   '아이',   '바꾸세요-아이'],
    ['부모님이름', '부모',   '바꾸세요-부모'],
    ['선생이름',   '선생',   '바꾸세요-선생']
  ];
  var have = {}, lastUsed = ROSTER_TOP - 1, mx = sh.getMaxRows();
  if (mx >= ROSTER_TOP) {
    var vals = sh.getRange(ROSTER_TOP, 1, mx - ROSTER_TOP + 1, 3).getValues();
    for (var i = 0; i < vals.length; i++) {
      var nm = norm_(vals[i][0]);
      if (nm) { have[nm] = true; lastUsed = ROSTER_TOP + i; }
    }
  }
  var add = [];
  for (var j = 0; j < want.length; j++) if (!have[norm_(want[j][0])]) add.push(want[j]);
  if (add.length) {
    var at = lastUsed + 1;
    if (sh.getMaxRows() < at + add.length) sh.insertRowsAfter(sh.getMaxRows(), add.length + 5);
    sh.getRange(at, 1, add.length, 3).setNumberFormat('@').setValues(add);
  }
  CacheService.getScriptCache().remove('tp_roster');
  Logger.log(add.length + '명 추가했습니다. 시트에서 이름과 코드를 실제 값으로 바꾸고 tpRosterAudit() 를 돌리세요.');
  return add.length;
}
