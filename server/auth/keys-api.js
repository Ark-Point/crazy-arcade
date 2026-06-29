'use strict';

// BYO-에이전트 API 키 관리 라우터.
// 세션으로 인증된 사용자가 자기 계정의 키를 조회/발급/폐기한다.
// 폐기(DELETE) 시 store.revokeKey 후, 해당 키에 바인딩된 라이브 소켓을
// liveSocketRegistry.socketsForKey(keyId) 로 조회해 즉시 강제 종료(disconnect(true))한다.
//
// 레지스트리 계약(S6 conn-guard 와 공유하는 선합의 인터페이스):
//   { socketsForKey(keyId) -> Iterable<{ disconnect(force) }> }
//
// store 는 수정하지 않는다. 소유권 확인은 store.listKeys(accountId) 만으로 한다
// (신규 store 메서드 추가 금지).

const express = require('express');

function createKeysRouter({ store, requireSession, liveSocketRegistry } = {}) {
  if (!store) throw new Error('store 가 필요합니다.');
  if (typeof requireSession !== 'function') throw new Error('requireSession 미들웨어가 필요합니다.');

  const router = express.Router();

  // POST 바디 파싱(라우터 단위로 격리). express.json() 미적용 환경 대비.
  router.use(express.json());

  // 모든 라우트를 세션으로 보호한다.
  router.use(requireSession);

  // GET /account/keys — 내 계정 키 목록(공개 뷰, keyHash 미노출).
  router.get('/account/keys', (req, res) => {
    const keys = store.listKeys(req.account.id);
    res.status(200).json({ ok: true, keys });
  });

  // POST /account/keys — 키 발급. 평문 key 는 이 응답에서 단 한 번만 노출된다.
  router.post('/account/keys', async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const label = body.label;
      const { key, record } = await store.issueKey(req.account.id, label);
      res.status(201).json({ ok: true, key, record });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /account/keys/:id — 소유한 키만 폐기. 타인 키는 404(존재 노출 금지).
  router.delete('/account/keys/:id', async (req, res, next) => {
    try {
      const keyId = req.params.id;
      // 소유권 확인: 내 계정 키 목록에 :id 가 존재하는가?
      const owned = store.listKeys(req.account.id).some((k) => k.id === keyId);
      if (!owned) {
        res.status(404).json({ ok: false, error: '키를 찾을 수 없습니다' });
        return;
      }

      const revoked = await store.revokeKey(keyId);

      // 폐기된 키에 바인딩된 라이브 소켓을 즉시 강제 종료한다(best-effort).
      // 레지스트리 부재/예외와 무관하게 폐기 자체는 이미 성립했으므로, 종료 단계의
      // 어떤 실패도 200 응답을 막지 않는다(throw 격리, 내결함성).
      let disconnected = 0;
      try {
        if (liveSocketRegistry && typeof liveSocketRegistry.socketsForKey === 'function') {
          const sockets = liveSocketRegistry.socketsForKey(keyId);
          if (sockets) {
            for (const socket of sockets) {
              if (socket && typeof socket.disconnect === 'function') {
                try {
                  socket.disconnect(true);
                  disconnected += 1;
                } catch {
                  /* 개별 소켓 종료 실패는 폐기 결과에 영향 주지 않음 */
                }
              }
            }
          }
        }
      } catch {
        /* socketsForKey 자체가 throw 해도 폐기는 유효(종료는 best-effort) */
      }

      res.status(200).json({ ok: true, revoked, disconnected });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createKeysRouter };
