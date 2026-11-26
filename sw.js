/* HWPX 뷰어 서비스 워커 — 앱 셸 프리캐시 + 네트워크 우선(오프라인 시 캐시 폴백) */
'use strict';

const VERSION = '7';
const CACHE = `hwpx-viewer-${VERSION}`;
const RUNTIME = `hwpx-viewer-runtime-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

/* 문서를 열려면 반드시 필요한 외부 라이브러리 — 오프라인에서도 열리도록 미리 받아 둔다 */
const VENDOR = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

/* 설치: 앱 셸을 미리 받아 둔다 (일부가 실패해도 설치 자체는 진행) */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(APP_SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await Promise.all(VENDOR.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

/* 활성화: 이전 버전 캐시 정리 후 바로 제어 */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE, RUNTIME]);
    const names = await caches.keys();
    await Promise.all(names.map((name) => (keep.has(name) ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

async function cachePut(name, request, response) {
  if (!response) return;
  if (response.type !== 'opaque' && !response.ok) return;
  try {
    const cache = await caches.open(name);
    await cache.put(request, response.clone());
  } catch (e) {
    /* 저장 실패는 무시 — 응답은 그대로 돌려준다 */
  }
}

/* 요청: 네트워크 우선, 실패하면 캐시 → 문서 요청은 앱 셸(index.html) 폴백 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;
  const isDocument = req.mode === 'navigate' || (req.destination === '' && sameOrigin);

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200) {
        cachePut(sameOrigin ? CACHE : RUNTIME, req, res);
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;

      if (isDocument) {
        const fallback = (await caches.match('./index.html')) || (await caches.match('./', { ignoreSearch: true }));
        if (fallback) return fallback;
      }

      return new Response('오프라인 상태이고 저장된 사본이 없습니다.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
