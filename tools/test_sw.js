/* Tests for sw.js.
 *
 * This is the mechanism every future deploy depends on, and its failure mode is
 * silent: the phone just keeps serving old code while the site is up to date.
 * So the caching strategy is exercised directly here, against a mock Cache API.
 *
 * Node 18+ supplies real Request/Response/URL, so only `caches`, `fetch` and the
 * ServiceWorkerGlobalScope bits need faking.
 *
 * Run: node tools/test_sw.js quiz-municipios
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const APP = process.argv[2];
const SCOPE = 'https://javidico.github.io/Municipios/quiz-municipios/';
const code = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (e) {
		failures.push(name);
		console.log('  FAIL ' + name + '\n       ' + (e.message || '').split('\n')[0]);
		process.exitCode = 1;
	}
}

const abs = u => new URL(typeof u === 'string' ? u : u.url, SCOPE).href;

// --- mock Cache API -------------------------------------------------------
// Bodies are stored as text and a fresh Response is handed out each time, which
// sidesteps "body already used" entirely.
class MockCache {
	constructor(name) {
		this.name = name;
		this.entries = new Map();
	}
	async match(request) {
		const hit = this.entries.get(abs(request));
		return hit ? new Response(hit.body, {status: 200}) : undefined;
	}
	async put(request, response) {
		this.entries.set(abs(request), {body: await response.text()});
	}
	async addAll(urls) {
		for (const url of urls) {
			const response = await fetch(abs(url));
			if (!response.ok) throw new TypeError('addAll failed for ' + url);
			await this.put(url, response);
		}
	}
	has(url) { return this.entries.has(abs(url)); }
	body(url) { const e = this.entries.get(abs(url)); return e && e.body; }
}

const cacheStorage = new Map();
const caches = {
	async open(name) {
		if (!cacheStorage.has(name)) cacheStorage.set(name, new MockCache(name));
		return cacheStorage.get(name);
	},
	async keys() { return [...cacheStorage.keys()]; },
	async delete(name) { return cacheStorage.delete(name); },
	async match(request) {
		for (const cache of cacheStorage.values()) {
			const hit = await cache.match(request);
			if (hit) return hit;
		}
		return undefined;
	}
};

// --- mock network ---------------------------------------------------------
const server = new Map();      // absolute url -> body served right now
const requests = [];           // every fetch the worker made
let offline = false;

function serve(url, body) { server.set(abs(url), body); }

global.fetch = async (input, init) => {
	const url = abs(input);
	requests.push({url, cache: (init && init.cache) || 'default'});
	if (offline) throw new TypeError('Failed to fetch');
	if (!server.has(url)) return new Response('not found', {status: 404});
	return new Response(server.get(url), {status: 200});
};
global.caches = caches;

// --- mock ServiceWorkerGlobalScope ---------------------------------------
const handlers = {};
let skipWaitingCalled = false;
let claimCalled = false;

global.self = {
	location: new URL(SCOPE + 'sw.js'),
	addEventListener: (type, fn) => { handlers[type] = fn; },
	skipWaiting: async () => { skipWaitingCalled = true; },
	clients: {claim: async () => { claimCalled = true; }},
	registration: {}
};

function makeEvent(extra) {
	const waits = [];
	return Object.assign({
		waitUntil: p => waits.push(p),
		respondWith: p => { this_response = p; },
		_settle: () => Promise.all(waits)
	}, extra);
}

let this_response;
async function dispatchFetch(url, mode) {
	this_response = undefined;
	// mode must not go through the constructor: the spec forbids scripts from
	// creating a 'navigate' request, so Node throws. Only the browser makes them,
	// and the worker just reads .mode, so overriding the property is faithful.
	const event = makeEvent({request: new Request(abs(url))});
	Object.defineProperty(event.request, 'mode', {value: mode || 'cors'});
	handlers.fetch(event);
	const response = this_response ? await this_response : undefined;
	await event._settle();
	return response;
}

// Populate the origin with the real files so install() behaves realistically.
const ALL = ['', 'index.html', 'style.css', 'storage.js', 'shell.js', 'main.js',
	'manifest.webmanifest', 'municipios.js', 'map.js',
	'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
	'icons/icon-512-maskable.png', 'icons/favicon-32.png',
	'outlines/outline-spain.json'];
for (const rel of ALL) {
	const file = rel === '' ? 'index.html' : rel;
	serve('./' + rel, 'v1:' + file);
}

(async () => {
	eval(code);

	console.log('install');
	await test('caches the shell and the static assets, not the 17 MB of data', async () => {
		const event = makeEvent({});
		handlers.install(event);
		await event._settle();
		const cache = await caches.open('quiz-municipios-v4');
		['./', './index.html', './style.css', './storage.js', './shell.js',
			'./main.js', './manifest.webmanifest'].forEach(u =>
			assert.ok(cache.has(u), u + ' was not cached at install'));
		assert.ok(cache.has('./outlines/outline-spain.json'), 'overlay not cached');
		assert.ok(cache.has('./icons/icon-512.png'), 'icons not cached');
		assert.ok(skipWaitingCalled, 'skipWaiting was never called');
	});
	await test('warms map.js and municipios.js in the background', async () => {
		// Not awaited by install, so give the warm loop a turn to finish.
		await new Promise(r => setTimeout(r, 20));
		const cache = await caches.open('quiz-municipios-v4');
		assert.ok(cache.has('./map.js'), 'map.js was never warmed');
		assert.ok(cache.has('./municipios.js'), 'municipios.js was never warmed');
	});

	console.log('\nactivate');
	await test('deletes caches from older versions and keeps the current one', async () => {
		cacheStorage.set('quiz-municipios-v3', new MockCache('quiz-municipios-v3'));
		cacheStorage.set('otra-app-v9', new MockCache('otra-app-v9'));
		const event = makeEvent({});
		handlers.activate(event);
		await event._settle();
		assert.strictEqual(cacheStorage.has('quiz-municipios-v3'), false,
			'the old version cache was left behind');
		assert.ok(cacheStorage.has('quiz-municipios-v4'), 'the current cache was deleted');
		assert.ok(cacheStorage.has('otra-app-v9'), 'clobbered another app cache');
		assert.ok(claimCalled, 'clients.claim was never called');
	});

	console.log('\nshell assets pick up a redeploy on their own');
	await test('serves the cached copy immediately', async () => {
		requests.length = 0;
		serve('./main.js', 'v2:main.js');            // a new deploy is live
		const body = await (await dispatchFetch('./main.js')).text();
		assert.strictEqual(body, 'v1:main.js',
			'launch waited on the network instead of serving the cache');
	});
	await test('and refreshes the cache in the background for next launch', async () => {
		const cache = await caches.open('quiz-municipios-v4');
		assert.strictEqual(cache.body('./main.js'), 'v2:main.js',
			'the background refresh never landed; the phone would stay on v1 forever');
	});
	await test('so the next launch gets the new version', async () => {
		const body = await (await dispatchFetch('./main.js')).text();
		assert.strictEqual(body, 'v2:main.js');
	});
	await test('the refresh revalidates instead of trusting the HTTP cache', async () => {
		const hit = requests.find(r => r.url === abs('./main.js'));
		assert.ok(hit, 'no request was made at all');
		assert.strictEqual(hit.cache, 'no-cache',
			"served from the HTTP cache, so Pages' max-age=600 could hide the deploy");
	});

	console.log('\nheavy data is never revalidated');
	await test('map.js comes from cache with no network request', async () => {
		requests.length = 0;
		serve('./map.js', 'v2:map.js');
		const body = await (await dispatchFetch('./map.js')).text();
		assert.strictEqual(body, 'v1:map.js', 'map.js was not served from cache');
		assert.deepStrictEqual(requests, [],
			're-fetched 16 MB on launch: ' + JSON.stringify(requests));
	});
	await test('the prebuilt overlay is not revalidated either', async () => {
		requests.length = 0;
		await dispatchFetch('./outlines/outline-spain.json');
		assert.deepStrictEqual(requests, []);
	});

	console.log('\noffline');
	await test('a shell asset still resolves from cache', async () => {
		offline = true;
		const response = await dispatchFetch('./style.css');
		assert.ok(response, 'no response at all');
		assert.strictEqual(await response.text(), 'v1:style.css');
	});
	await test('a navigation still resolves from the cached shell', async () => {
		const response = await dispatchFetch('./', 'navigate');
		assert.ok(response, 'no response at all');
		assert.strictEqual(response.status, 200,
			'launching offline failed with status ' + response.status);
		assert.strictEqual(await response.text(), 'v1:index.html');
		offline = false;
	});

	console.log('\nnavigation online');
	await test('serves the shell and refreshes index.html behind it', async () => {
		// A navigation requests the directory URL, and the refresh stores what
		// comes back under the './index.html' key. On any static host those are
		// the same resource, so a deploy has to move both together here too.
		serve('./index.html', 'v2:index.html');
		serve('./', 'v2:index.html');
		const response = await dispatchFetch('./', 'navigate');
		assert.strictEqual(await response.text(), 'v1:index.html');
		const cache = await caches.open('quiz-municipios-v4');
		assert.strictEqual(cache.body('./index.html'), 'v2:index.html',
			'index.html was not refreshed, so a redeploy would never load');
	});

	console.log('\n' + passed + ' checks passed'
		+ (failures.length ? ', ' + failures.length + ' FAILED: ' + failures.join(', ') : ''));
})();
