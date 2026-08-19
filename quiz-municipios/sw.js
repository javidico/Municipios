/* Service worker for Quiz Municipios.
 *
 * Two jobs: make the app launch instantly from the home screen, and make it
 * work with no connection at all.
 *
 * Assets are split by how they behave on a redeploy, because one strategy cannot
 * serve both ends of a 17 MB app:
 *
 *   SHELL   Small files that change whenever the app changes. Served from cache
 *           for an instant launch, then revalidated in the background, so a new
 *           deploy is picked up on the *next* launch with no version bump. This
 *           is what stops "I pushed a fix and my phone never saw it".
 *
 *   STATIC  Icons and the prebuilt border overlay. Small but effectively
 *           immutable, so straight from cache.
 *
 *   DATA    map.js and municipios.js, ~17 MB together. Straight from cache:
 *           revalidating these on every launch would defeat the whole point.
 *
 * STATIC and DATA only refresh when CACHE_VERSION changes, so bump it if you
 * regenerate the icons, the overlay, or the map data.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = 'quiz-municipios-' + CACHE_VERSION;

const SHELL_ASSETS = [
	'./',
	'./index.html',
	'./style.css',
	'./storage.js',
	'./shell.js',
	'./main.js',
	'./manifest.webmanifest'
];

const STATIC_ASSETS = [
	'./icons/apple-touch-icon.png',
	'./icons/icon-192.png',
	'./icons/icon-512.png',
	'./icons/icon-512-maskable.png',
	'./icons/favicon-32.png',
	'./outlines/outline-spain.png'
];

// Large. Warmed in the background so a failed download cannot fail the install.
const DATA_ASSETS = [
	'./municipios.js',
	'./map.js'
];

const INDEX_KEY = './index.html';

// Resolved once, so the fetch handler can classify a request by its URL.
const SHELL_URLS = new Set(SHELL_ASSETS.map(p => new URL(p, self.location.href).href));

self.addEventListener('install', event => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE_NAME);
		await cache.addAll(SHELL_ASSETS.concat(STATIC_ASSETS));
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
			if (await cache.match(url)) continue;
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

// Serve the cached copy at once, then refresh it for next time. The refresh asks
// for 'no-cache' so it revalidates against the server rather than being answered
// from the HTTP cache, which GitHub Pages sets to max-age=600.
async function staleWhileRevalidate(event, cacheKey) {
	const cache = await caches.open(CACHE_NAME);
	const key = cacheKey || event.request;
	const cached = await cache.match(key);

	const refresh = (async () => {
		try {
			const response = await fetch(event.request.url, {cache: 'no-cache'});
			if (response && response.ok) await cache.put(key, response.clone());
			return response;
		} catch (e) {
			return null;   // offline: the cached copy is the answer
		}
	})();

	if (cached) {
		// Without waitUntil the worker can be killed as soon as the cached
		// response is returned, and the refresh never lands.
		event.waitUntil(refresh);
		return cached;
	}
	return (await refresh) || Response.error();
}

async function cacheFirst(event) {
	const cached = await caches.match(event.request);
	if (cached) return cached;
	try {
		const response = await fetch(event.request);
		if (response && response.ok) {
			const cache = await caches.open(CACHE_NAME);
			await cache.put(event.request, response.clone());
		}
		return response;
	} catch (e) {
		return Response.error();
	}
}

self.addEventListener('fetch', event => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	const sameOrigin = url.origin === self.location.origin;

	// Navigations: the cached shell answers immediately so launching offline
	// works, and the background refresh means a redeploy lands next launch.
	if (request.mode === 'navigate') {
		event.respondWith((async () => {
			const response = await staleWhileRevalidate(event, INDEX_KEY);
			if (response && response.ok) return response;
			return new Response(
				'<h1>Sin conexión</h1><p>Abre la app una vez con conexión para guardarla.</p>',
				{status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}}
			);
		})());
		return;
	}

	if (!sameOrigin) {
		// Google Fonts and anything else external: network first, falling back to
		// whatever is cached. Never let it break an offline launch.
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

	if (SHELL_URLS.has(url.href)) {
		event.respondWith(staleWhileRevalidate(event));
		return;
	}

	event.respondWith(cacheFirst(event));
});
