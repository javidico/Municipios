/* Cascade tests for style.css.
 *
 * These exist because two of them catch bugs that are invisible in the source
 * and obvious on screen: a `.hidden` rule that loses on source order (the modal
 * renders over the page on load) and an input font-size under 16px (iOS zooms
 * the whole page in whenever the field is focused).
 *
 * Run: node tools/test_css.js quiz-municipios
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {JSDOM} = require('jsdom');

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
		console.log('  FAIL ' + name + '\n       ' + (e.message || '').split('\n')[0]);
		process.exitCode = 1;
	}
}

// The stylesheet is inlined so jsdom applies it without needing to fetch it.
const html = read('index.html').replace(
	'<link rel="stylesheet" href="style.css">',
	'<style>' + read('style.css') + '</style>'
);
const dom = new JSDOM(html, {pretendToBeVisual: true});
const {window} = dom;
const doc = window.document;
const css = prop => el => window.getComputedStyle(el).getPropertyValue(prop);
const display = css('display');

console.log('hidden elements stay hidden');
test('the export/import modal is not shown on load', () => {
	const modal = doc.getElementById('dataModal');
	assert.ok(modal.classList.contains('hidden'), 'modal lost its hidden class');
	assert.strictEqual(display(modal), 'none',
		'the modal is rendering over the page on load');
});
test('the install hint is not shown on load', () => {
	const hint = doc.getElementById('installHint');
	assert.ok(hint.classList.contains('hidden'));
	assert.strictEqual(display(hint), 'none');
});
test('removing hidden actually reveals them as flex', () => {
	const modal = doc.getElementById('dataModal');
	modal.classList.remove('hidden');
	assert.strictEqual(display(modal), 'flex');
	const hint = doc.getElementById('installHint');
	hint.classList.remove('hidden');
	assert.strictEqual(display(hint), 'flex');
});

console.log('iOS input behaviour');
test('the guess field is at least 16px so iOS does not auto-zoom', () => {
	const size = css('font-size')(doc.getElementById('municipioInput'));
	const px = parseFloat(size);
	assert.ok(!Number.isNaN(px), 'no font-size resolved, got ' + JSON.stringify(size));
	assert.ok(px >= 16, 'font-size is ' + px + 'px; anything under 16 makes iOS zoom');
});

console.log('\n' + passed + ' checks passed'
	+ (failures.length ? ', ' + failures.length + ' FAILED: ' + failures.join(', ') : ''));
