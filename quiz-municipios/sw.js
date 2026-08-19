/* Service worker for Quiz Municipios.
 *
 * Two jobs: make the app launch instantly from the home screen, and make it
 * work with no connection at all. Bump CACHE_VERSION whenever any precached
 * file changes, otherwise clients keep serving the old copy forever.
 *
 * The map data is ~17 MB, so it is deliberately NOT part of the blocking
 * install step: a single flaky request would fail the whole installation and
 * leave the app uninstallable. Instead the shell installs immediately and the
 * heavy files are warmed in the background, with the fetch handler caching
 * whatever it sees on demand as a backstop.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'quiz-municipios-' + CACHE_VERSION;

// Small, must-have files. Installation fails if any of these fail.
const CORE_ASSETS = [
	'./',
	'./index.html',
	'./style.css',
	'./storage.js',
	'./shell.js',
	'./main.js',
	'./manifest.webmanifest',
	'./icons/apple-touch-icon.png',
	'./icons/icon-192.png',
	'./icons/icon-512.png',
	'./icons/icon-512-maskable.png',
	'./icons/favicon-32.png',
	'./outlines/outline-spain.png'
];

// Large data files. Warmed in the background, never block installation.
const DATA_ASSETS = [
	'./municipios.js',
	'./map.js'
];

self.addEventListener('install', event => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		await cache.addAll(CORE_ASSETS);
		// Kick the big files off without awaiting them, so a slow or dropped
		// connection cannot block the install.
		warmDataAssets();
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(
			names
				.filter(n => n.startsWith('quiz-municipios-') && n !== CACHE_NAME)
				.map(n => caches.delete(n))
		);
		await self.clients.claim();
	})());
});

async function warmDataAssets() {
	const cache = await caches.open(CACHE_NAME);
	for (const url of DATA_ASSETS) {
		try {
			const existing = await cache.match(url);
			if (existing) continue;
			const response = await fetch(url, {cache: 'reload'});
			if (response && response.ok) await cache.put(url, response);
		} catch (e) {
			// Left for the fetch handler to pick up on the next page load.
		}
	}
}

self.addEventListener('message', event => {
	if (event.data === 'warm-data') warmDataAssets();
});

self.addEventListener('fetch', event => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	const sameOrigin = url.origin === self.location.origin;

	// Navigations: serve the cached shell so launching offline works, and fall
	// back to the network only when there is nothing cached yet.
	if (request.mode === 'navigate') {
		event.respondWith((async () => {
			const cached = await caches.match('./index.html');
			if (cached) return cached;
			try {
				return await fetch(request);
			} catch (e) {
				return new Response(
					'<h1>Sin conexión</h1><p>Abre la app una vez con conexión para guardarla.</p>',
					{status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}}
				);
			}
		})());
		return;
	}

	if (!sameOrigin) {
		// Google Fonts and anything else external: network first, fall back to
		// whatever happens to be cached. Never let it break an offline launch.
		event.respondWith(
			fetch(request)
				.then(response => {
					if (response && (response.ok || response.type === 'opaque')) {
						caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
					}
					return response;
				})
				.catch(() => caches.match(request).then(r => r || Response.error()))
		);
		return;
	}

	// Same-origin assets: cache first, then network, caching what we fetch.
	event.respondWith((async () => {
		const cached = await caches.match(request);
		if (cached) return cached;
		try {
			const response = await fetch(request);
			if (response && response.ok) {
				const cache = await caches.open(CACHE_NAME);
				cache.put(request, response.clone());
			}
			return response;
		} catch (e) {
			return Response.error();
		}
	})());
});
