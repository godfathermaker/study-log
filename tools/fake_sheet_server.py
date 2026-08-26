#!/usr/bin/env python3
"""
가짜 구글시트 서버 — 동기화 계층 시험용.

Apps Script 의 **불편한 성질들을 일부러 재현한다.** 그것들이 CPX 에서 실제로
데이터를 날렸기 때문이다:

  · 스크립트 락    한 번에 하나만 처리한다. 못 잡으면 그 요청은 통째로 버려진다
                   (no-cors 라 클라이언트는 실패한 줄도 모른다)
  · 웜 지연        요청당 2.6초쯤
  · 콜드스타트     20초 놀았다가 오면 첫 요청이 15초
  · JSONP          GET 은 callback= 으로 감싸 돌려준다
  · 역할 격리      읽을 수 없는 표는 응답에 **키 자체가 없다**

시험용 주입구:
  POST /__fail?on=1     이후 모든 POST 를 조용히 버린다 (탭 닫힘·락 경쟁 재현)
  POST /__fail?on=0     복구
  GET  /__dump          서버가 실제로 들고 있는 것 전부
  POST /__reset         비운다
  GET  /__stat          요청 수·버린 수

  --fast 를 주면 지연을 0 으로 (기능 시험용). 지연 시험은 --fast 없이.

  python3 tools/fake_sheet_server.py --port 8787 [--fast]
"""
import argparse, json, os, re, threading, time, sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE = ['rid', '수정시각', '삭제']
TABLES = {
    '학원':     BASE + ['이름', '과목', '색', '상태', '시작일', '종료일', '메모'],
    '일정':     BASE + ['학원rid', '요일', '시작', '종료', '유효시작일', '유효종료일'],
    '과제':     BASE + ['학원rid', '등록일', '마감일', '내용', '분량', '상태', '완료일', '작성자'],
    '학습기록': BASE + ['날짜', '시각', '과목', '학원rid', '내용', '소요분', '작성자'],
    '피드백':   BASE + ['날짜', '학원rid', '경로', '원문', '태그', '감성', '입력자', '확인'],
    '성적':     BASE + ['날짜', '학원rid', '시험명', '점수', '만점', '등수', '응시인원', '백분율'],
    '목표':     BASE + ['연월', '항목', '목표내용', '지표', '목표값', '현재값', '비고'],
}
PERM = {
    '학원':     {'r': ['child', 'parent', 'teacher'], 'w': ['parent', 'teacher']},
    '일정':     {'r': ['child', 'parent', 'teacher'], 'w': ['parent', 'teacher']},
    '과제':     {'r': ['child', 'parent', 'teacher'], 'w': ['child', 'parent', 'teacher']},
    '학습기록': {'r': ['child', 'parent', 'teacher'], 'w': ['child', 'teacher']},
    '피드백':   {'r': ['parent', 'teacher'],          'w': ['parent', 'teacher']},
    '성적':     {'r': ['parent', 'teacher'],          'w': ['parent', 'teacher']},
    '목표':     {'r': ['child', 'parent', 'teacher'], 'w': ['parent', 'teacher']},
}

SHARED = 'family-2026'
ROSTER = {                      # 세 사람의 코드가 서로 다르다 — 이게 격리의 근거다
    '민준':   {'role': 'child',   'code': 'child-pw'},
    '어머니': {'role': 'parent',  'code': 'parent-pw'},
    '권민영': {'role': 'teacher', 'code': 'teacher-pw'},
}

DB = {t: {} for t in TABLES}
LOCK = threading.Lock()
STATE = {'last': 0.0, 'fail': False, 'posts': 0, 'dropped': 0, 'gets': 0, 'cold': 0}
CFG = {'warm': 2.6, 'cold': 15.0, 'idle': 20.0, 'lock_wait': 25.0}


def think():
    """콜드스타트와 웜 지연. 락을 잡은 채로 흐른다 — Apps Script 가 그렇다."""
    now = time.time()
    gap = now - STATE['last']
    d = CFG['cold'] if (STATE['last'] and gap > CFG['idle']) or not STATE['last'] else CFG['warm']
    if d == CFG['cold']:
        STATE['cold'] += 1
    STATE['last'] = now
    if d:
        time.sleep(d)
    STATE['last'] = time.time()


def auth(name, code):
    name = re.sub(r'\s+', ' ', (name or '')).strip()
    ent = ROSTER.get(name)
    if not ent:
        return None, 'not allowed'
    if not ent['role']:
        return None, 'no role'
    if (code or '').strip() != (ent['code'] or SHARED):
        return None, 'bad code'
    return {'name': name, 'role': ent['role']}, None


def upsert(t, ops, who, now_ms):
    tbl = DB[t]
    n = stale = 0
    for op in ops:
        rid = str(op.get('rid') or '')
        if not rid:
            continue
        ts = op.get('ts')
        if not isinstance(ts, (int, float)) or ts <= 0 or ts > now_ms + 300000:
            ts = now_ms
        prev = tbl.get(rid)
        if prev and prev.get('_ts', 0) > ts:      # 역전 방지
            stale += 1
            continue
        row = dict(prev) if prev else {'rid': rid}
        row['_ts'] = ts
        row['_del'] = 1 if op.get('del') else 0
        for k, v in (op.get('d') or {}).items():
            if k in TABLES[t] and TABLES[t].index(k) >= 3:
                row[k] = '' if v is None else (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v))
        if prev is None:                      # 만든 사람만 기록한다 (수정자로 덮지 않는다)
            if '작성자' in TABLES[t]:
                row['작성자'] = who
            if '입력자' in TABLES[t]:
                row['입력자'] = who
        tbl[rid] = row
        n += 1
    return n, stale


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        b = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b)

    # ── GET ────────────────────────────────────────────────────────
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        if u.path == '/__dump':
            return self._send(200, json.dumps(DB, ensure_ascii=False))
        if u.path == '/__stat':
            return self._send(200, json.dumps(STATE))

        if u.path != '/exec':
            return super().do_GET()

        STATE['gets'] += 1
        got = LOCK.acquire(timeout=CFG['lock_wait'])
        try:
            if not got:
                return self._send(200, 'timeout')
            think()
            me, err = auth(q.get('name'), q.get('code'))
            if err:
                payload = {'ok': False, 'err': err}
            elif q.get('probe'):
                payload = {'ok': True, 'probe': 1, 'role': me['role']}
            else:
                data = {}
                for t in TABLES:
                    if me['role'] not in PERM[t]['r']:
                        continue          # ← 키 자체를 만들지 않는다
                    data[t] = DB[t]
                payload = {'ok': True, 'role': me['role'], 'data': data}
            payload['now'] = int(time.time() * 1000)
            payload['v'] = 'fake'
            body = json.dumps(payload, ensure_ascii=False)
            cb = q.get('callback')
            if cb:
                return self._send(200, cb + '(' + body + ');',
                                  'text/javascript; charset=utf-8')
            return self._send(200, body)
        finally:
            if got:
                LOCK.release()

    # ── POST ───────────────────────────────────────────────────────
    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}

        if u.path == '/__fail':
            STATE['fail'] = q.get('on') == '1'
            return self._send(200, json.dumps(STATE))
        if u.path == '/__reset':
            for t in DB:
                DB[t].clear()
            STATE.update(posts=0, dropped=0, gets=0, cold=0, last=0.0, fail=False)
            return self._send(200, '{"ok":true}')

        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n).decode('utf-8', 'replace')

        if STATE['fail']:
            STATE['dropped'] += 1
            return self._send(200, '{"ok":false,"err":"injected"}')

        STATE['posts'] += 1
        got = LOCK.acquire(timeout=CFG['lock_wait'])
        try:
            if not got:                          # 락을 못 잡으면 통째로 버린다
                STATE['dropped'] += 1
                return self._send(200, '{"ok":false,"err":"lock"}')
            think()
            try:
                d = json.loads(raw)
            except Exception as e:
                return self._send(200, json.dumps({'ok': False, 'err': str(e)}))
            me, err = auth(d.get('name'), d.get('code'))
            if err:
                return self._send(200, json.dumps({'ok': False, 'err': err}))
            by_t, denied = {}, 0
            for op in (d.get('ops') or []):
                t = op.get('t')
                if t not in TABLES or not op.get('rid'):
                    denied += 1
                    continue
                if me['role'] not in PERM[t]['w']:   # ← 서버측 쓰기 차단
                    denied += 1
                    continue
                by_t.setdefault(t, []).append(op)
            now_ms = int(time.time() * 1000)
            total = stale = 0
            for t, ops in by_t.items():
                a, b = upsert(t, ops, me['name'], now_ms)
                total += a
                stale += b
            return self._send(200, json.dumps({'ok': True, 'n': total,
                                               'denied': denied, 'stale': stale}))
        finally:
            if got:
                LOCK.release()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8787)
    ap.add_argument('--fast', action='store_true', help='지연 없음 (기능 시험용)')
    a = ap.parse_args()
    if a.fast:
        CFG.update(warm=0.0, cold=0.0, idle=1e9)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), H)
    print('fake sheet on http://127.0.0.1:%d  (%s)'
          % (a.port, 'fast' if a.fast else 'warm %.1fs / cold %.1fs' % (CFG['warm'], CFG['cold'])),
          flush=True)
    srv.serve_forever()
