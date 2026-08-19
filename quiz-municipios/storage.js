/* Persistence for Quiz Municipios.
 *
 * The original game kept everything in localStorage.state and nothing else.
 * That is fine on a desktop browser but loses progress on an iPhone, because
 * Safari evicts all script-writable storage after 7 days of not visiting a
 * site. Installing the app to the home screen is what actually exempts it from
 * that eviction; this module adds the two other layers worth having:
 *
 *   1. An IndexedDB mirror, so a cleared or corrupted localStorage does not
 *      take the progress with it.
 *   2. Explicit export / import, which is the only backup that survives
 *      *anything* -- including reinstalling the app or moving to a new URL.
 *
 * The localStorage key stays 'state' with the exact same shape as before, so
 * data written by the original version is read back without conversion.
 */

var QuizStorage = (function() {
	const STORAGE_KEY = 'state';
	const DB_NAME = 'quizMunicipios';
	const DB_VERSION = 1;
	const STORE = 'backup';
	const BACKUP_KEY = 'current';
	const EXPORT_FORMAT = 'quiz-municipios/1';

	/* ---------- shape helpers ---------- */

	// Accepts anything and returns a {region: [ids]} object with no duplicates
	// and no non-string entries. Unknown regions are preserved rather than
	// dropped, so a future map does not lose data on an older build.
	function sanitize(raw) {
		var clean = {};
		if (!raw || typeof raw !== 'object') return clean;
		Object.keys(raw).forEach(function(region) {
			var list = raw[region];
			if (!Array.isArray(list)) return;
			var seen = Object.create(null);
			clean[region] = list.filter(function(id) {
				if (typeof id !== 'string' || seen[id]) return false;
				seen[id] = true;
				return true;
			});
		});
		return clean;
	}

	function counts(state) {
		var out = {};
		Object.keys(state || {}).forEach(function(r) {
			out[r] = (state[r] || []).length;
		});
		return out;
	}

	function total(state) {
		return Object.keys(state || {}).reduce(function(sum, r) {
			return sum + (state[r] || []).length;
		}, 0);
	}

	// Union per region, keeping the order of `base` and appending anything only
	// present in `extra`. Never drops a discovered municipio.
	function merge(base, extra) {
		var out = sanitize(base);
		var incoming = sanitize(extra);
		Object.keys(incoming).forEach(function(region) {
			if (!out[region]) out[region] = [];
			var seen = Object.create(null);
			out[region].forEach(function(id) { seen[id] = true; });
			incoming[region].forEach(function(id) {
				if (!seen[id]) {
					out[region].push(id);
					seen[id] = true;
				}
			});
		});
		return out;
	}

	/* ---------- localStorage ---------- */

	function readLocal() {
		try {
			if (!localStorage[STORAGE_KEY]) return null;
			return sanitize(JSON.parse(localStorage[STORAGE_KEY]));
		} catch (e) {
			console.warn('No se pudo leer el estado de localStorage', e);
			return null;
		}
	}

	function writeLocal(state) {
		try {
			localStorage[STORAGE_KEY] = JSON.stringify(state);
			return true;
		} catch (e) {
			console.warn('No se pudo guardar el estado en localStorage', e);
			return false;
		}
	}

	/* ---------- IndexedDB mirror ---------- */

	var dbPromise = null;

	function openDb() {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise(function(resolve, reject) {
			if (!self.indexedDB) return reject(new Error('IndexedDB no disponible'));
			var request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = function() {
				var db = request.result;
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
			};
			request.onsuccess = function() { resolve(request.result); };
			request.onerror = function() { reject(request.error); };
			request.onblocked = function() { reject(new Error('IndexedDB bloqueada')); };
		}).catch(function(e) {
			dbPromise = null;
			throw e;
		});
		return dbPromise;
	}

	function writeBackup(state) {
		return openDb().then(function(db) {
			return new Promise(function(resolve, reject) {
				var tx = db.transaction(STORE, 'readwrite');
				tx.objectStore(STORE).put({
					state: state,
					savedAt: new Date().toISOString(),
					total: total(state)
				}, BACKUP_KEY);
				tx.oncomplete = function() { resolve(true); };
				tx.onerror = function() { reject(tx.error); };
				tx.onabort = function() { reject(tx.error); };
			});
		}).catch(function(e) {
			console.warn('No se pudo escribir la copia en IndexedDB', e);
			return false;
		});
	}

	function readBackup() {
		return openDb().then(function(db) {
			return new Promise(function(resolve, reject) {
				var tx = db.transaction(STORE, 'readonly');
				var request = tx.objectStore(STORE).get(BACKUP_KEY);
				request.onsuccess = function() { resolve(request.result || null); };
				request.onerror = function() { reject(request.error); };
			});
		}).catch(function(e) {
			console.warn('No se pudo leer la copia de IndexedDB', e);
			return null;
		});
	}

	/* ---------- recovery ---------- */

	// Returns a state strictly richer than `current` when the IndexedDB mirror
	// survived something localStorage did not, otherwise null. Clearing a region
	// with "Borrar" also rewrites the mirror, so a deliberate reset is never
	// resurrected here.
	function recover(current) {
		return readBackup().then(function(backup) {
			if (!backup || !backup.state) return null;
			var restored = merge(current, backup.state);
			return total(restored) > total(current) ? restored : null;
		});
	}

	/* ---------- export / import ---------- */

	function serialize(state) {
		return JSON.stringify({
			format: EXPORT_FORMAT,
			exportedAt: new Date().toISOString(),
			counts: counts(state),
			state: state
		}, null, '\t');
	}

	// Accepts either a full export wrapper or a bare {region: [ids]} object, so
	// the raw value of localStorage.state copied out of the original site can be
	// pasted straight in.
	function parseImport(text) {
		if (!text || !String(text).trim()) throw new Error('No has pegado nada.');
		var data;
		try {
			data = JSON.parse(String(text).trim());
		} catch (e) {
			throw new Error('Eso no es JSON válido.');
		}
		var candidate = (data && typeof data === 'object' && data.state) ? data.state : data;
		var state = sanitize(candidate);
		var regions = Object.keys(state);
		if (!regions.length) throw new Error('No he encontrado ningún mapa en esos datos.');
		if (!total(state)) throw new Error('Esos datos no contienen ningún municipio.');
		return state;
	}

	function filename() {
		// Local date, so the file name matches the day the user pressed export.
		var d = new Date();
		var pad = function(n) { return String(n).padStart(2, '0'); };
		return 'quiz-municipios-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
			+ '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
	}

	/* ---------- storage durability ---------- */

	function requestPersistence() {
		if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(null);
		return navigator.storage.persisted()
			.then(function(already) { return already ? true : navigator.storage.persist(); })
			.catch(function() { return null; });
	}

	function estimate() {
		if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
		return navigator.storage.estimate().catch(function() { return null; });
	}

	return {
		sanitize: sanitize,
		counts: counts,
		total: total,
		merge: merge,
		readLocal: readLocal,
		writeLocal: writeLocal,
		writeBackup: writeBackup,
		readBackup: readBackup,
		recover: recover,
		serialize: serialize,
		parseImport: parseImport,
		filename: filename,
		requestPersistence: requestPersistence,
		estimate: estimate
	};
})();
