'use strict';

// G003 advisory-scan — 두 검증 레인의 경계를 강제하는 스크립트.
//
// 레인 구분:
//  - required-green(blocking): `node --test test/agent-*.js` 의 B 테스트들.
//    이들은 반드시 통과해야 하며 실패 시 CI 가 빨간불(스위트 exit≠0)이 된다.
//  - advisory(이 스크립트): 미구현 미래 동작을 명세한 A-레인 { todo:true } 테스트들.
//    오늘은 'not ok ... # TODO' 라 스위트 실패를 유발하지 않는다(exit 0 유지).
//    그러나 구현이 착지하면 통과 todo 가 'ok ... # TODO' 로 표면화된다.
//    이 스크립트는 그 "통과 todo" 를 감지해, 해당 동작을 blocking(required-green)
//    레인으로 승격(=todo 플래그 제거)하도록 촉구하기 위해 의도적으로 exit 1 을 낸다.
//
// 즉, advisory-scan 의 exit 1 은 "버그" 가 아니라 "축하/승격 신호" 다:
//   통과 todo 0건 → exit 0 (아직 구현 전, 정상).
//   통과 todo ≥1건 → exit 1 (구현 착지, blocking 승격 검토 필요).
//
// CLI replay sandbox PATH 에는 node 가 없을 수 있으나(bun 만), 이 스크립트는
// node 로 직접 실행하는 테스트 러너 전용이라 무관하다(spawn 으로 node 를 호출).

const { spawn } = require('child_process');

// 글롭 없이 4개 arena 파일을 명시(결정적·재현 가능한 표면).
const TEST_FILES = [
  'test/agent-protocol.js',
  'test/agent-fairness.js',
  'test/agent-robustness.js',
  'test/agent-lifecycle.js',
];

// 통과 todo 의 TAP 표기: 'ok N - ... # TODO'. (실패 todo 는 'not ok ...' 라 매칭 안 됨.)
const PASSING_TODO = /^ok\b.*#\s*TODO/m;

function main() {
  // URL/PORT env 를 자식에 전파해 외부서버 모드(URL 지정)도 그대로 지원.
  const child = spawn(
    'node',
    ['--test', '--test-reporter=tap', ...TEST_FILES],
    { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] }
  );

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.on('error', (err) => {
    console.error(`advisory-scan: failed to spawn node --test: ${err.message}`);
    process.exit(2);
  });

  child.on('close', () => {
    // 통과-todo 줄 개수 카운트(line-by-line, 정규식은 ^ok ... # TODO).
    let count = 0;
    for (const line of stdout.split('\n')) {
      if (PASSING_TODO.test(line)) count += 1;
    }

    if (count > 0) {
      console.log(
        `ADVISORY: ${count} passing todo(s) — 구현 착지, blocking 승격 검토 ` +
          `(해당 A-테스트의 { todo:true } 플래그를 제거해 required-green 레인으로 올려라)`
      );
      process.exit(1);
    }

    console.log('advisory: 0 passing todos');
    process.exit(0);
  });
}

main();
