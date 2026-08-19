/* Integration test: boot the real index.html with the real data in jsdom and
 * check the game still works end to end after the PWA changes.
 *
 * jsdom gives us no canvas and no IndexedDB, so drawProvinceOutlines() and the
 * IndexedDB mirror are expected to no-op here. Everything else is the real code
 * path, including the 16 MB map and the full 8k-municipio dataset.
 *
 * Run: node test_app.js <app-dir> [region]
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {JSDOM, VirtualConsole} = require('jsdom');

const APP = process.argv[2];
const read = f => fs.readFileSync(path.join(APP, f), 'utf8');

let passed = 0;
const failures = [];
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (e) {
		failures.push(name);
		console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       '));
		process.exitCode = 1;
	}
}

// Collect page errors rather than letting jsdom print them, so an exception in
// loadPage() becomes a test failure instead of noise.
const pageErrors = [];
const warnings = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => pageErrors.push(e.message));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));
virtualConsole.on('warn', (...a) => warnings.push(a.join(' ')));
virtualConsole.on('log', () => {});

console.log('booting index.html in jsdom (this parses the 16 MB map) ...');
const t0 = Date.now();

const dom = new JSDOM(read('index.html'), {
	url: 'https://example.test/quiz-municipios/',
	runScripts: 'dangerously',
	pretendToBeVisual: true,
	virtualConsole
});
const {window} = dom;

// jsdom has no canvas backend; make getContext explicit about it so
// drawProvinceOutlines fails fast and silently instead of half-running.
window.HTMLCanvasElement.prototype.getContext = () => null;

// jsdom implements neither of these. Stubbing them lets drawProvinceOutlines run
// to the point where it hands off to an <image> load that never completes,
// which is exactly how it should degrade when rasterising is unavailable.
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};

// jsdom will not load images at all without the native canvas package, so the
// prebuilt-outline branch would be unreachable. This stub resolves against the
// real filesystem: onload when the file exists, onerror when it does not, which
// is exactly the signal drawProvinceOutlines() branches on.
const loadedImages = [];
window.Image = class {
	constructor() {
		this.onload = null;
		this.onerror = null;
		this._src = '';
	}
	set src(value) {
		this._src = value;
		const isBlob = String(value).startsWith('blob:');
		const exists = !isBlob && fs.existsSync(path.join(APP, value));
		loadedImages.push({src: value, exists: exists});
		setTimeout(() => {
			if (exists) {
				if (this.onload) this.onload();
			} else if (this.onerror) {
				this.onerror();
			}
		}, 0);
	}
	get src() { return this._src; }
};

// jsdom has no fetch. This one resolves against the real filesystem so the
// prebuilt vector overlay is loaded from the actual file on disk, and a missing
// one 404s exactly as it would on the server.
const fetched = [];
window.fetch = async (input) => {
	const url = String(input);
	fetched.push(url);
	const file = path.join(APP, url);
	if (!fs.existsSync(file)) return new Response('not found', {status: 404});
	return new Response(fs.readFileSync(file, 'utf8'), {status: 200});
};

// Layout, which jsdom does not compute. The zoom maths is all in these numbers,
// so without them commit() bails out and nothing can be verified.
const VIEW_W = 390;                                 // a phone's CSS width
const VIEW_H = Math.round(390 * 1006.6781 / 1769.1083);
function stubLayout() {
	const viewport = window.document.getElementById('mapViewport');
	const map = window.document.getElementById('mapSvg');
	Object.defineProperty(viewport, 'clientWidth', {value: VIEW_W});
	Object.defineProperty(viewport, 'clientHeight', {value: VIEW_H});
	Object.defineProperty(map, 'offsetWidth', {value: VIEW_W});
	Object.defineProperty(map, 'offsetHeight', {value: VIEW_H});
}

// A real IndexedDB, so the mirror and the recovery path are genuinely exercised.
const fakeIndexedDB = require('fake-indexeddb');
window.indexedDB = fakeIndexedDB.indexedDB;
window.IDBKeyRange = fakeIndexedDB.IDBKeyRange;

// Injected as real <script> elements rather than window.eval(): top-level
// `const` in eval'd code stays inside the eval's own scope, so `const mapSvg`
// in map.js would never become visible to drawMap(), which is a property of the
// harness and not of the app.
for (const file of ['storage.js', 'shell.js', 'main.js', 'map.js', 'municipios.js']) {
	const el = window.document.createElement('script');
	el.textContent = read(file);
	window.document.head.appendChild(el);
}
if (typeof window.mapSvg === 'undefined' && typeof window.eval('typeof mapSvg') === 'undefined') {
	console.log('  FATAL: map.js did not define mapSvg');
	process.exit(1);
}
console.log('  scripts evaluated in %ds', ((Date.now() - t0) / 1000).toFixed(1));

// Fire the load handler the way the browser would.
stubLayout();
const t1 = Date.now();
window.onload();
console.log('  loadPage() completed in %ds', ((Date.now() - t1) / 1000).toFixed(1));

const doc = window.document;
const $ = id => doc.getElementById(id);

console.log('\nboot');
test('no page errors during boot', () => {
	assert.deepStrictEqual(pageErrors, []);
});
test('map svg was injected', () => {
	const svg = $('mapSvg').querySelector('svg');
	assert.ok(svg, 'no <svg> inside #mapSvg');
	assert.ok($('mapSvg').querySelectorAll('path').length > 10000,
		'expected the full Spain map, got ' + $('mapSvg').querySelectorAll('path').length + ' paths');
});
test('stats rendered', () => {
	assert.match($('numberOfMunicipios').textContent, /de .* municipios encontrados/);
	assert.match($('capitals').textContent, /capitales/);
	assert.match($('totalArea').textContent, /km²/);
});
test('provincia select was populated', () => {
	const options = $('selectStatsProvincia').querySelectorAll('option');
	// 52 provinces plus the "todas" entry.
	assert.ok(options.length >= 50, 'only ' + options.length + ' options');
	assert.strictEqual(options[0].value, 'all');
});
test('storage note reflects an empty start', () => {
	assert.match($('storageNote').textContent, /^0 municipios guardados/);
});

console.log('\nguessing');
function guess(name) {
	$('municipioInput').value = name;
	$('sendButton').dispatchEvent(new window.Event('click'));
}

test('a correct guess is recorded and painted', () => {
	guess('Madrid');
	const state = JSON.parse(window.localStorage.state);
	assert.ok(state.spain.includes('madrid'), 'madrid missing from state: ' + state.spain);
	const items = $('municipiosList').querySelectorAll('li');
	assert.strictEqual(items.length, 1);
	assert.strictEqual(items[0].textContent, 'Madrid');
	const paths = window.municipios.spain['madrid'].paths;
	paths.forEach(p => {
		const el = doc.getElementById(p);
		assert.ok(el, 'path ' + p + ' not in the svg');
		assert.ok(el.classList.contains('selected'), 'path ' + p + ' not marked selected');
	});
});
test('accents and case are normalised', () => {
	guess('  ÁVILA  ');
	const state = JSON.parse(window.localStorage.state);
	assert.ok(state.spain.includes('avila'), 'avila missing: ' + state.spain.slice(-3));
});
test('a duplicate guess does not double count', () => {
	const before = JSON.parse(window.localStorage.state).spain.length;
	guess('Madrid');
	assert.strictEqual(JSON.parse(window.localStorage.state).spain.length, before);
});
test('a wrong guess changes nothing', () => {
	const before = JSON.parse(window.localStorage.state).spain.length;
	guess('Kuala Lumpur');
	assert.strictEqual(JSON.parse(window.localStorage.state).spain.length, before);
});
test('stats follow the guesses', () => {
	assert.match($('numberOfMunicipios').textContent, /^2 de /);
});
test('storage note follows the guesses', () => {
	assert.match($('storageNote').textContent, /^2 municipios guardados/);
});

console.log('\nsorting');
test('population sort orders correctly', () => {
	$('selectSorting').value = 'population-desc';
	$('selectSorting').dispatchEvent(new window.Event('change'));
	const items = [...$('municipiosList').querySelectorAll('li')].map(li => li.textContent);
	assert.match(items[0], /^Madrid/, 'Madrid should lead by population, got ' + items[0]);
	assert.match(items[0], /\(/, 'expected the population in parentheses');
});

console.log('\nalphabetical sorting');
function sortBy(value) {
	$('selectSorting').value = value;
	$('selectSorting').dispatchEvent(new window.Event('change'));
	return [...$('municipiosList').querySelectorAll('li')].map(li => li.textContent);
}

test('the default sort is still the original one', () => {
	assert.strictEqual($('selectSorting').querySelector('option').value, 'order-desc',
		'the first option decides the default sort; it must not change silently');
});
test('name-asc puts the list in A-Z order', () => {
	// Deliberately spans accents, ñ and case.
	['Zamora', 'Ávila', 'Añora', 'Aoiz', 'Alcañiz', 'ólvega', 'Badajoz'].forEach(n => guess(n));
	const items = sortBy('name-asc');
	const expected = [...items].sort((a, b) => new Intl.Collator('es').compare(a, b));
	assert.deepStrictEqual(items, expected);
});
test('accents sort with their base letter, not after Z', () => {
	const items = sortBy('name-asc');
	const avila = items.indexOf('Ávila');
	const badajoz = items.indexOf('Badajoz');
	const zamora = items.indexOf('Zamora');
	assert.ok(avila !== -1 && badajoz !== -1 && zamora !== -1,
		'missing test municipios: ' + items.join(', '));
	assert.ok(avila < badajoz, 'Ávila should precede Badajoz, got ' + items.join(', '));
	assert.ok(avila < zamora, 'Ávila sorted after Zamora, so collation is byte order');
});
test('ñ sorts before o, which raw string comparison gets wrong', () => {
	// This is the pair that actually proves Spanish collation is in use. In
	// Spanish n < ñ < o, but by code unit o is U+006F and ñ is U+00F1, so a plain
	// `<` puts Aoiz first. An n-vs-ñ pair would NOT catch it: both orderings
	// agree there, so it would pass with a broken comparator.
	const items = sortBy('name-asc');
	const anora = items.findIndex(n => n.startsWith('Añora'));
	const aoiz = items.findIndex(n => n.startsWith('Aoiz'));
	assert.ok(anora !== -1, 'Añora never made it into the list: ' + items.join(', '));
	assert.ok(aoiz !== -1, 'Aoiz never made it into the list: ' + items.join(', '));
	assert.ok(anora < aoiz,
		'Añora must precede Aoiz; got ' + items.join(', ') + ' -- comparator is byte order');
});
test('name-desc is the exact reverse', () => {
	const asc = sortBy('name-asc');
	const desc = sortBy('name-desc');
	assert.deepStrictEqual(desc, [...asc].reverse());
});
test('sorting by name shows no parenthesised extra info', () => {
	assert.ok(sortBy('name-asc').every(n => n.indexOf('(') === -1),
		'name sort should not append population or area');
});
test('switching back to another sort still works', () => {
	const items = sortBy('population-desc');
	assert.ok(items.length > 0);
	assert.match(items[0], /\(/, 'population sort lost its extra info');
});

console.log('\nexport / import');
test('export produces an importable payload', () => {
	$('exportButton').dispatchEvent(new window.Event('click'));
	const text = $('modalText').value;
	assert.ok(text.length > 10, 'export box is empty');
	const parsed = JSON.parse(text);
	assert.strictEqual(parsed.format, 'quiz-municipios/1');
	assert.ok(parsed.state.spain.includes('madrid'));
	assert.strictEqual($('modalPrimary').classList.contains('hidden'), true,
		'the import button should be hidden while exporting');
});
test('import merges without dropping current progress', () => {
	$('importButton').dispatchEvent(new window.Event('click'));
	$('modalText').value = JSON.stringify({spain: ['leon', 'segovia']});
	$('modalPrimary').dispatchEvent(new window.Event('click'));
	const state = JSON.parse(window.localStorage.state);
	['madrid', 'avila', 'leon', 'segovia'].forEach(id =>
		assert.ok(state.spain.includes(id), id + ' missing after import'));
	assert.match($('modalStatus').textContent, /Importados 2 municipios/);
});
test('imported municipios are painted on the map', () => {
	const el = doc.getElementById(window.municipios.spain['leon'].paths[0]);
	assert.ok(el.classList.contains('selected'), 'leon not painted after import');
});
test('import rejects rubbish with a message', () => {
	$('modalText').value = 'no soy json';
	$('modalPrimary').dispatchEvent(new window.Event('click'));
	assert.match($('modalStatus').textContent, /no es JSON/i);
	assert.ok($('modalStatus').classList.contains('error'));
});

console.log('\nborrar');
test('Borrar asks first and clears when confirmed', () => {
	let asked = false;
	window.confirm = msg => { asked = true; return true; };
	$('borrarButton').dispatchEvent(new window.Event('click'));
	assert.ok(asked, 'Borrar did not ask for confirmation');
	assert.deepStrictEqual(JSON.parse(window.localStorage.state).spain, []);
	assert.strictEqual($('municipiosList').querySelectorAll('li').length, 0);
	assert.match($('numberOfMunicipios').textContent, /^0 de /);
});
test('Borrar can be cancelled', () => {
	guess('Madrid');
	window.confirm = () => false;
	$('borrarButton').dispatchEvent(new window.Event('click'));
	assert.deepStrictEqual(JSON.parse(window.localStorage.state).spain, ['madrid']);
});
test('Borrar does not duplicate listeners', () => {
	// The old code called loadPage() again, which re-registered every handler,
	// so the second Borrar fired the confirm twice.
	let asks = 0;
	window.confirm = () => { asks++; return true; };
	$('borrarButton').dispatchEvent(new window.Event('click'));
	assert.strictEqual(asks, 1, 'confirm fired ' + asks + ' times: listeners duplicated');
});

(async () => {
	console.log('\nIndexedDB mirror and recovery');
	const QS = window.QuizStorage;

	// The app has work in flight that cannot progress while the tests above run
	// synchronously: the debounced backup timer, plus the promise chain that
	// attemptRecovery() started at boot. Both resolve on the first await here and
	// would otherwise overwrite whatever these tests store. Settle them first.
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	for (let i = 0; i < 3; i++) {
		window.flushBackup();
		await sleep(200);
	}

	async function testAsync(name, fn) {
		try {
			await fn();
			passed++;
			console.log('  ok   ' + name);
		} catch (e) {
			failures.push(name);
			console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n')[0]);
			process.exitCode = 1;
		}
	}

	await testAsync('writeBackup then readBackup round trips', async () => {
		const s = {spain: ['madrid', 'leon'], madrid: [], murcia: [], cadiz: []};
		assert.strictEqual(await QS.writeBackup(s), true);
		const backup = await QS.readBackup();
		assert.ok(backup, 'no backup came back');
		assert.deepStrictEqual(JSON.parse(JSON.stringify(backup.state.spain)), ['madrid', 'leon']);
		assert.strictEqual(backup.total, 2);
		assert.ok(backup.savedAt, 'no savedAt stamp');
	});

	await testAsync('recover() restores progress after localStorage is wiped', async () => {
		// The exact iOS failure mode: Safari evicted localStorage, the mirror lived.
		await QS.writeBackup({spain: ['madrid', 'leon', 'avila'], madrid: [], murcia: [], cadiz: []});
		delete window.localStorage.state;
		const empty = {spain: [], madrid: [], murcia: [], cadiz: []};
		const restored = await QS.recover(empty);
		assert.ok(restored, 'recover() returned nothing');
		assert.deepStrictEqual(restored.spain, ['madrid', 'leon', 'avila']);
	});

	await testAsync('recover() returns null when nothing was lost', async () => {
		const same = {spain: ['madrid', 'leon', 'avila'], madrid: [], murcia: [], cadiz: []};
		await QS.writeBackup(same);
		assert.strictEqual(await QS.recover(same), null);
	});

	await testAsync('recover() does not resurrect a deliberate Borrar', async () => {
		const cleared = {spain: [], madrid: [], murcia: [], cadiz: []};
		await QS.writeBackup(cleared);
		assert.strictEqual(await QS.recover(cleared), null);
	});

	console.log('\nprebuilt province outline');
	await testAsync('the prebuilt spain overlay is loaded and is vector', async () => {
		assert.ok(fetched.indexOf('outlines/outline-spain.json') !== -1,
			'never asked for the prebuilt overlay; fetched: ' + fetched.join(', '));
		const overlay = doc.querySelector('#mapSvg svg #mapOutline');
		assert.ok(overlay, 'no #mapOutline was appended to the svg');
		assert.strictEqual(overlay.tagName.toLowerCase(), 'path',
			'the overlay is still a raster <image>, so it will blur when zoomed');
		const d = overlay.getAttribute('d');
		assert.ok(d && d.length > 1000, 'overlay path data looks empty: ' + d);
		assert.strictEqual(overlay.getAttribute('fill'), 'none');
		assert.strictEqual(overlay.getAttribute('vector-effect'), 'non-scaling-stroke',
			'without this the border is invisible at 1x or a smear when zoomed');
	});

	await testAsync('redrawing does not stack up overlays', async () => {
		window.drawProvinceOutlines();
		window.drawProvinceOutlines();
		await sleep(50);
		assert.strictEqual(doc.querySelectorAll('#mapOutline').length, 1);
	});

	await testAsync('a map with no prebuilt file falls back without throwing', async () => {
		// murcia ships no overlay, so this must take the runtime raster branch. It
		// cannot finish here (no canvas backend) but it must not blow up either.
		const before = pageErrors.length;
		window.provincia = 'murcia';
		window.drawProvinceOutlines();
		await sleep(50);
		window.provincia = 'spain';
		assert.ok(fetched.indexOf('outlines/outline-murcia.json') !== -1,
			'never tried outlines/outline-murcia.json');
		assert.strictEqual(pageErrors.length, before,
			'fallback threw: ' + pageErrors.slice(before));
	});

	console.log('\nmap zoom commits to the viewBox (so it stays sharp)');
	const VB = {w: 1769.1083, h: 1006.6781};
	const viewportEl = doc.getElementById('mapViewport');
	const mapEl = doc.getElementById('mapSvg');

	function touch(type, points) {
		const event = new window.Event(type, {bubbles: true, cancelable: true});
		Object.defineProperty(event, 'touches', {
			value: points.map(p => ({clientX: p[0], clientY: p[1]}))
		});
		viewportEl.dispatchEvent(event);
	}
	function viewBoxOf() {
		const vb = doc.querySelector('#mapSvg svg').getAttribute('viewBox');
		return vb.trim().split(/\s+/).map(Number);
	}

	await testAsync('starts at the full map with no transform', async () => {
		window.resetMapZoom();
		const [x, y, w, h] = viewBoxOf();
		assert.ok(Math.abs(w - VB.w) < 0.01 && Math.abs(h - VB.h) < 0.01,
			'expected the natural viewBox, got ' + viewBoxOf().join(' '));
		assert.strictEqual(x, 0);
		assert.strictEqual(y, 0);
		assert.strictEqual(window.mapZoomState().zoom, 1);
	});

	await testAsync('a 2x pinch halves the viewBox and keeps the centre put', async () => {
		// Two fingers 111.8px apart, then spread to exactly twice that, with the
		// midpoint pinned to the centre of the viewport.
		touch('touchstart', [[145, 86], [245, 136]]);
		touch('touchmove', [[95, 61], [295, 161]]);
		assert.ok(Math.abs(window.mapZoomState().scale - 2) < 0.001,
			'gesture scale is ' + window.mapZoomState().scale);
		touch('touchend', []);

		const [x, y, w, h] = viewBoxOf();
		assert.ok(Math.abs(w - VB.w / 2) < 0.5,
			'viewBox width should halve; got ' + w + ' of ' + VB.w);
		assert.ok(Math.abs(h - VB.h / 2) < 0.5, 'viewBox height should halve; got ' + h);
		// The map point under the viewport centre must not move.
		assert.ok(Math.abs((x + w / 2) - VB.w / 2) < 1.0,
			'centre drifted in x: ' + (x + w / 2) + ' vs ' + VB.w / 2);
		assert.ok(Math.abs((y + h / 2) - VB.h / 2) < 1.0,
			'centre drifted in y: ' + (y + h / 2) + ' vs ' + VB.h / 2);
	});

	await testAsync('the CSS transform is dropped once committed', async () => {
		// This is the whole point: a lingering transform means the browser keeps
		// showing a scaled bitmap instead of re-rendering the vector.
		assert.strictEqual(mapEl.style.transform, '',
			'transform still set to "' + mapEl.style.transform + '"');
		const state = window.mapZoomState();
		assert.strictEqual(state.scale, 1);
		assert.strictEqual(state.tx, 0);
		assert.strictEqual(state.ty, 0);
		assert.ok(Math.abs(state.zoom - 2) < 0.01, 'total zoom is ' + state.zoom);
	});

	await testAsync('will-change is not left pinned after the gesture', async () => {
		assert.strictEqual(viewportEl.classList.contains('gesturing'), false,
			'the gesturing class survived, so the layer stays rasterised');
	});

	await testAsync('zoom cannot go below the full map', async () => {
		// Pinch inwards hard from the 2x view: it must stop at the whole map.
		touch('touchstart', [[145, 86], [245, 136]]);
		touch('touchmove', [[190, 108], [200, 114]]);
		touch('touchend', []);
		const [x, y, w, h] = viewBoxOf();
		assert.ok(w <= VB.w + 0.01, 'viewBox grew past the map: ' + w);
		assert.ok(x >= -0.01 && y >= -0.01, 'panned outside the map: ' + x + ',' + y);
		assert.ok(window.mapZoomState().zoom >= 1 - 1e-9);
	});

	await testAsync('double tap returns to the full map', async () => {
		touch('touchstart', [[145, 86], [245, 136]]);
		touch('touchmove', [[95, 61], [295, 161]]);
		touch('touchend', []);
		assert.ok(window.mapZoomState().zoom > 1.5, 'setup failed to zoom in');
		touch('touchend', []);
		touch('touchend', []);
		const [x, y, w, h] = viewBoxOf();
		assert.ok(Math.abs(w - VB.w) < 0.01, 'double tap did not reset; w=' + w);
		assert.strictEqual(mapEl.style.transform, '');
	});

	await testAsync('zoom is capped rather than running away', async () => {
		for (let i = 0; i < 12; i++) {
			touch('touchstart', [[145, 86], [245, 136]]);
			touch('touchmove', [[45, 36], [345, 186]]);
			touch('touchend', []);
		}
		const zoom = window.mapZoomState().zoom;
		assert.ok(zoom <= 14.001, 'zoom ran past the cap: ' + zoom);
		assert.ok(zoom > 10, 'zoom should have reached the cap, got ' + zoom);
		window.resetMapZoom();
	});

	console.log('\nno unexpected errors');
	test('nothing threw during the whole run', () => {
		assert.deepStrictEqual(pageErrors, []);
	});

	console.log('\n' + passed + ' checks passed'
		+ (failures.length ? ', ' + failures.length + ' FAILED: ' + failures.join(', ') : ''));
	if (warnings.length) {
		console.log('warnings seen: '
			+ [...new Set(warnings.map(w => w.slice(0, 60)))].join(' | '));
	}
})();
