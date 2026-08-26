#!/usr/bin/env python3
"""
권한표가 세 곳에서 같은지 대조한다.

  index.html                   PERM  (화면 정리용)
  tools/appsscript_academy.gs  PERM  (진짜 격리)
  tools/fake_sheet_server.py   PERM  (시험용 모사)

셋이 어긋나면 격리가 깨지거나(서버가 더 허용) 화면이 이유 없이 비거나(서버가 덜 허용)
시험이 실제와 다른 것을 검증하게 된다. 권한을 건드렸다면 이걸 먼저 돌릴 것.

  python3 tools/check_perm.py      # 어긋나면 exit 1
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KO = {'child': '아이', 'parent': '부모', 'teacher': '선생'}


def grab(path, block_re, entry_re):
    src = open(os.path.join(ROOT, path), encoding='utf-8').read()
    m = re.search(block_re, src, re.S)
    if not m:
        sys.exit('PERM 블록을 못 찾음: ' + path)
    out = {}
    for name, r, w in re.findall(entry_re, m.group(1)):
        split = lambda x: sorted(v.strip().strip("'") for v in x.split(',') if v.strip())
        out[name] = {'r': split(r), 'w': split(w)}
    if not out:
        sys.exit('PERM 항목을 못 읽음: ' + path)
    return out


client = grab('index.html', r"var PERM = \{(.*?)\n\};",
              r"'([^']+)':\s*\{r:\[([^\]]*)\],\s*w:\[([^\]]*)\]\}")
server = grab('tools/appsscript_academy.gs', r"var PERM = \{(.*?)\n\};",
              r"'([^']+)':\s*\{ r: \[([^\]]*)\],\s*w: \[([^\]]*)\] \}")
fake = grab('tools/fake_sheet_server.py', r"PERM = \{(.*?)\n\}",
            r"'([^']+)':\s*\{'r': \[([^\]]*)\],\s*'w': \[([^\]]*)\]\}")

bad = []
for t in sorted(set(list(client) + list(server) + list(fake))):
    if not (client.get(t) == server.get(t) == fake.get(t)):
        bad.append(t)
        print('❌ %s' % t)
        print('   클라이언트  %s' % client.get(t))
        print('   Apps Script %s' % server.get(t))
        print('   가짜 서버   %s' % fake.get(t))

if bad:
    print('\n%d개 표가 어긋납니다. 세 파일을 같이 고치세요.' % len(bad))
    sys.exit(1)

print('세 곳 일치 ✓  (표 %d개)\n' % len(server))
print('%-10s %-24s %s' % ('표', '읽기', '쓰기'))
print('-' * 56)
for t, v in server.items():
    print('%-10s %-24s %s' % (t, ' '.join(KO[x] for x in v['r']),
                              ' '.join(KO[x] for x in v['w'])))
print('\n아이가 못 보는 것: %s' %
      ', '.join(t for t, v in server.items() if 'child' not in v['r']))
