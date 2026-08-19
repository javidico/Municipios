/* Tests for storage.js -- the module that decides whether progress survives.
 * Run: node test_storage.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const APP = process.argv[2];
const code = fs.readFileSync(path.join(APP, 'storage.js'), 'utf8');

// Loaded in this realm rather than a vm context on purpose: objects built in a
// separate realm have a different Object.prototype, which makes every
// deepStrictEqual fail on prototype identity alone.
function load() {
	const store = {};
	globalThis.localStorage = store;
	globalThis.self = {};
	globalThis.navigator = {};
	eval(code + '\nglobalThis.__QS = QuizStorage;');
	return {QS: globalThis.__QS, store};
}

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok   ' + name);
	} catch (e) {
		console.log('  FAIL ' + name + '\n       ' + e.message);
		process.exitCode = 1;
	}
}

const {QS, store} = load();

console.log('sanitize');
test('drops duplicates, keeps order', () => {
	const s = QS.sanitize({spain: ['madrid', 'leon', 'madrid', 'avila']});
	assert.deepStrictEqual(s.spain, ['madrid', 'leon', 'avila']);
});
test('drops non-strings and non-arrays', () => {
	const s = QS.sanitize({spain: ['madrid', 42, null, {a: 1}, 'leon'], bogus: 'nope'});
	assert.deepStrictEqual(s.spain, ['madrid', 'leon']);
	assert.strictEqual('bogus' in s, false);
});
test('tolerates garbage input', () => {
	assert.deepStrictEqual(QS.sanitize(null), {});
	assert.deepStrictEqual(QS.sanitize('x'), {});
	assert.deepStrictEqual(QS.sanitize(undefined), {});
});
test('preserves unknown regions', () => {
	const s = QS.sanitize({spain: ['madrid'], galicia: ['vigo']});
	assert.deepStrictEqual(Object.keys(s).sort(), ['galicia', 'spain']);
});

console.log('merge');
test('unions without losing either side', () => {
	const m = QS.merge({spain: ['a', 'b']}, {spain: ['b', 'c']});
	assert.deepStrictEqual(m.spain, ['a', 'b', 'c']);
});
test('keeps base order and appends new', () => {
	const m = QS.merge({spain: ['z', 'y']}, {spain: ['x']});
	assert.deepStrictEqual(m.spain, ['z', 'y', 'x']);
});
test('adds regions only present in extra', () => {
	const m = QS.merge({spain: ['a']}, {madrid: ['b']});
	assert.deepStrictEqual(m, {spain: ['a'], madrid: ['b']});
});
test('does not mutate its arguments', () => {
	const base = {spain: ['a']};
	const extra = {spain: ['b']};
	QS.merge(base, extra);
	assert.deepStrictEqual(base, {spain: ['a']});
	assert.deepStrictEqual(extra, {spain: ['b']});
});
test('empty extra is a no-op', () => {
	assert.deepStrictEqual(QS.merge({spain: ['a']}, {}), {spain: ['a']});
	assert.deepStrictEqual(QS.merge({spain: ['a']}, null), {spain: ['a']});
});

console.log('total / counts');
test('total sums every region', () => {
	assert.strictEqual(QS.total({spain: ['a', 'b'], madrid: ['c']}), 3);
	assert.strictEqual(QS.total({}), 0);
	assert.strictEqual(QS.total(null), 0);
});
test('counts reports per region', () => {
	assert.deepStrictEqual(QS.counts({spain: ['a', 'b'], madrid: []}), {spain: 2, madrid: 0});
});

console.log('localStorage round trip');
test('write then read returns the same state', () => {
	const s = {spain: ['madrid', 'leon'], madrid: [], murcia: [], cadiz: []};
	assert.strictEqual(QS.writeLocal(s), true);
	assert.deepStrictEqual(QS.readLocal(), s);
});
test('reads null when nothing is stored', () => {
	delete store.state;
	assert.strictEqual(QS.readLocal(), null);
});
test('survives corrupted JSON instead of throwing', () => {
	// The warning is the expected behaviour here; silence it so it does not
	// look like a test failure in the output.
	const warn = console.warn;
	console.warn = () => {};
	store.state = '{not json';
	assert.strictEqual(QS.readLocal(), null);
	console.warn = warn;
});
test('sanitizes what it reads back', () => {
	store.state = JSON.stringify({spain: ['a', 'a', 7]});
	assert.deepStrictEqual(QS.readLocal(), {spain: ['a']});
});

console.log('parseImport');
test('accepts a full export wrapper', () => {
	const wrapped = QS.serialize({spain: ['madrid'], madrid: [], murcia: [], cadiz: []});
	assert.deepStrictEqual(QS.parseImport(wrapped).spain, ['madrid']);
});
test('accepts a bare localStorage.state value', () => {
	const raw = JSON.stringify({spain: ['madrid', 'leon'], cadiz: []});
	assert.deepStrictEqual(QS.parseImport(raw).spain, ['madrid', 'leon']);
});
test('rejects empty input', () => {
	assert.throws(() => QS.parseImport(''), /No has pegado nada/);
	assert.throws(() => QS.parseImport('   '), /No has pegado nada/);
});
test('rejects non-JSON', () => {
	assert.throws(() => QS.parseImport('hola'), /no es JSON/i);
});
test('rejects JSON with no regions', () => {
	assert.throws(() => QS.parseImport('{}'), /ningún mapa/);
	assert.throws(() => QS.parseImport('[1,2,3]'), /ningún mapa/);
});
test('rejects a state with zero municipios', () => {
	assert.throws(() => QS.parseImport('{"spain":[]}'), /ningún municipio/);
});
test('tolerates surrounding whitespace', () => {
	assert.deepStrictEqual(QS.parseImport('\n\t {"spain":["a"]} \n').spain, ['a']);
});

console.log('serialize');
test('round trips through parseImport', () => {
	const original = {spain: ['a', 'b'], madrid: ['c'], murcia: [], cadiz: []};
	const back = QS.parseImport(QS.serialize(original));
	assert.deepStrictEqual(back, original);
});
test('records counts and a format tag', () => {
	const data = JSON.parse(QS.serialize({spain: ['a'], madrid: []}));
	assert.strictEqual(data.format, 'quiz-municipios/1');
	assert.deepStrictEqual(data.counts, {spain: 1, madrid: 0});
	assert.ok(data.exportedAt);
});

console.log('filename');
test('is a safe .json name', () => {
	assert.match(QS.filename(), /^quiz-municipios-\d{8}-\d{4}\.json$/);
});

console.log('\nrecovery semantics (the part that matters for data loss)');
test('backup richer than local wins', () => {
	// Simulates: Safari evicted localStorage, IndexedDB mirror survived.
	const local = {spain: [], madrid: [], murcia: [], cadiz: []};
	const backup = {spain: ['madrid', 'leon'], madrid: [], murcia: [], cadiz: []};
	const merged = QS.merge(local, backup);
	assert.strictEqual(QS.total(merged) > QS.total(local), true);
	assert.deepStrictEqual(merged.spain, ['madrid', 'leon']);
});
test('stale backup never resurrects a deliberate Borrar', () => {
	// After Borrar, both stores hold the cleared value, so the merge is a no-op
	// and recover() returns null because the total did not grow.
	const local = {spain: [], madrid: [], murcia: [], cadiz: []};
	const backup = {spain: [], madrid: [], murcia: [], cadiz: []};
	assert.strictEqual(QS.total(QS.merge(local, backup)) > QS.total(local), false);
});
test('backup poorer than local is ignored', () => {
	const local = {spain: ['a', 'b', 'c']};
	const backup = {spain: ['a']};
	assert.strictEqual(QS.total(QS.merge(local, backup)) > QS.total(local), false);
});

console.log('\n' + passed + ' assertions passed'
	+ (process.exitCode ? ' -- WITH FAILURES' : ''));
