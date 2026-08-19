/* App shell for Quiz Municipios: installability, backup/restore and map zoom.
 *
 * Kept out of main.js's loadPage() on purpose. loadPage() runs more than once,
 * and anything that registers listeners in there ends up attached several times
 * over. Everything here is wired exactly once, from initShell().
 */

var recoveredCount = 0;

// Everything loadPage() does, minus re-registering event listeners.
function redrawAll() {
	drawMap();
	drawProvinceOutlines();
	drawMunicipiosList();
	drawStats();
}

function isStandalone() {
	if (window.navigator.standalone === true) return true;
	return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function isIos() {
	var ua = navigator.userAgent || "";
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	// iPadOS 13+ reports itself as a Mac; the touch points give it away.
	return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function updateStorageNote() {
	var note = document.getElementById("storageNote");
	if (!note) return;
	var lines = [beautifyNumber(QuizStorage.total(state))
		+ " municipios guardados en este dispositivo."];
	if (recoveredCount > 0) {
		lines.push("Se recuperaron " + beautifyNumber(recoveredCount)
			+ " desde la copia local.");
	}
	if (!isStandalone()) {
		lines.push("Sin instalar en la pantalla de inicio, iOS puede borrarlos tras 7 días.");
	}
	note.textContent = lines.join(" ");
}

function initShell() {
	registerServiceWorker();
	attemptRecovery();
	setupInstallHint();
	setupDataModal();
	setupMapZoom();
	updateStorageNote();

	QuizStorage.requestPersistence();

	// Last chance to persist before iOS suspends or discards the page.
	window.addEventListener('pagehide', flushBackup);
	document.addEventListener('visibilitychange', function() {
		if (document.visibilityState === 'hidden') flushBackup();
	});
}

function registerServiceWorker() {
	if (!('serviceWorker' in navigator)) return;
	navigator.serviceWorker.register('sw.js').then(function(reg) {
		// Ask the worker to pull the ~17 MB of map data down in the background so
		// the next launch works with no connection at all.
		if (navigator.serviceWorker.controller) {
			navigator.serviceWorker.controller.postMessage('warm-data');
		}
		return reg;
	}).catch(function(e) {
		console.warn('No se pudo registrar el service worker', e);
	});
}

// If localStorage was wiped but the IndexedDB mirror survived, put the progress
// back. Runs before any backup write is scheduled, so it cannot lose the race.
function attemptRecovery() {
	QuizStorage.recover(state).then(function(restored) {
		if (!restored) {
			flushBackup();
			return;
		}
		recoveredCount = QuizStorage.total(restored) - QuizStorage.total(state);
		state = restored;
		QuizStorage.writeLocal(state);
		flushBackup();
		redrawAll();
		updateStorageNote();
	});
}

function setupInstallHint() {
	var hint = document.getElementById("installHint");
	var dismiss = document.getElementById("dismissInstall");
	if (!hint || !dismiss) return;
	if (isStandalone() || !isIos() || localStorage.installHintDismissed === "1") return;
	hint.classList.remove("hidden");
	dismiss.addEventListener("click", function() {
		hint.classList.add("hidden");
		try { localStorage.installHintDismissed = "1"; } catch (e) {}
	});
}

/* --- export / import ------------------------------------------------------ */

function setupDataModal() {
	var modal = document.getElementById("dataModal");
	var title = document.getElementById("modalTitle");
	var help = document.getElementById("modalHelp");
	var text = document.getElementById("modalText");
	var status = document.getElementById("modalStatus");
	var primary = document.getElementById("modalPrimary");
	var copyBtn = document.getElementById("modalCopy");
	var shareBtn = document.getElementById("modalShare");
	var downloadBtn = document.getElementById("modalDownload");
	var closeBtn = document.getElementById("modalClose");
	var exportBtn = document.getElementById("exportButton");
	var importBtn = document.getElementById("importButton");
	if (!modal || !exportBtn || !importBtn) return;

	function setStatus(message, kind) {
		status.textContent = message || "";
		status.className = "modalStatus" + (kind ? " " + kind : "");
	}

	function open(mode) {
		var exporting = mode === "export";
		modal.classList.remove("hidden");
		setStatus("");
		[copyBtn, shareBtn, downloadBtn].forEach(function(b) {
			b.classList.toggle("hidden", !exporting);
		});
		if (!navigator.share) shareBtn.classList.add("hidden");

		if (exporting) {
			title.textContent = "Exportar copia";
			help.textContent = "Guarda este texto donde quieras. Es tu copia de "
				+ "seguridad completa y sirve para restaurar el progreso en "
				+ "cualquier dispositivo.";
			text.value = QuizStorage.serialize(state);
			text.readOnly = true;
			primary.classList.add("hidden");
		} else {
			title.textContent = "Importar copia";
			help.textContent = "Pega aquí una copia exportada. También vale el valor "
				+ "crudo de localStorage.state del sitio original. Los municipios se "
				+ "suman a los que ya tienes, no se sustituyen.";
			text.value = "";
			text.readOnly = false;
			primary.textContent = "Importar y combinar";
			primary.classList.remove("hidden");
		}
	}

	function close() {
		modal.classList.add("hidden");
	}

	exportBtn.addEventListener("click", function() { open("export"); });
	importBtn.addEventListener("click", function() { open("import"); });
	closeBtn.addEventListener("click", close);
	modal.addEventListener("click", function(event) {
		if (event.target === modal) close();
	});

	primary.addEventListener("click", function() {
		var imported;
		try {
			imported = QuizStorage.parseImport(text.value);
		} catch (e) {
			setStatus(e.message, "error");
			return;
		}
		var before = QuizStorage.total(state);
		state = QuizStorage.merge(state, imported);
		var added = QuizStorage.total(state) - before;
		QuizStorage.writeLocal(state);
		flushBackup();
		redrawAll();
		updateStorageNote();
		setStatus(added
			? "Importados " + beautifyNumber(added) + " municipios nuevos."
			: "Esa copia no tenía nada que no tuvieras ya.", "ok");
	});

	copyBtn.addEventListener("click", function() {
		var failed = function() {
			// Selecting the text is the fallback when the clipboard API is
			// unavailable or blocked: the user can then copy it by hand.
			text.readOnly = false;
			text.focus();
			text.setSelectionRange(0, text.value.length);
			text.readOnly = true;
			setStatus("Copia el texto seleccionado manualmente.", "error");
		};
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text.value).then(function() {
				setStatus("Copiado al portapapeles.", "ok");
			}, failed);
		} else {
			failed();
		}
	});

	shareBtn.addEventListener("click", function() {
		var name = QuizStorage.filename();
		var payload = {title: "Quiz Municipios", text: text.value};
		if (window.File && navigator.canShare) {
			var file = new File([text.value], name, {type: "application/json"});
			if (navigator.canShare({files: [file]})) payload = {files: [file], title: name};
		}
		navigator.share(payload).catch(function() { /* user cancelled */ });
	});

	downloadBtn.addEventListener("click", function() {
		var blob = new Blob([text.value], {type: "application/json"});
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = QuizStorage.filename();
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
	});
}

/* --- map pinch zoom ------------------------------------------------------- */

function setupMapZoom() {
	var viewport = document.getElementById("mapViewport");
	var map = document.getElementById("mapSvg");
	if (!viewport || !map) return;

	var MIN_SCALE = 1;
	var MAX_SCALE = 14;
	var scale = 1, tx = 0, ty = 0;
	var pinch = null;      // {d0, s0, px, py} while two fingers are down
	var pan = null;        // {x, y, tx, ty} while dragging a zoomed map
	var lastTap = 0;

	function clamp() {
		if (scale < MIN_SCALE) scale = MIN_SCALE;
		if (scale > MAX_SCALE) scale = MAX_SCALE;
		var vw = viewport.clientWidth;
		var vh = viewport.clientHeight;
		var cw = map.offsetWidth * scale;
		var ch = map.offsetHeight * scale;
		tx = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, tx));
		ty = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, ty));
	}

	function apply() {
		clamp();
		map.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
		// Only claim the gesture once zoomed in, so at 1x a vertical drag still
		// scrolls the page instead of being swallowed by the map.
		viewport.classList.toggle("zoomed", scale > 1.001);
	}

	function reset() {
		scale = 1;
		tx = 0;
		ty = 0;
		apply();
	}

	function distance(a, b) {
		var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function midpoint(a, b) {
		var box = viewport.getBoundingClientRect();
		return {
			x: (a.clientX + b.clientX) / 2 - box.left,
			y: (a.clientY + b.clientY) / 2 - box.top
		};
	}

	function zoomAround(mx, my, nextScale) {
		// Keep whatever content point sits under (mx, my) exactly where it is.
		var px = (mx - tx) / scale;
		var py = (my - ty) / scale;
		scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
		tx = mx - px * scale;
		ty = my - py * scale;
		apply();
	}

	viewport.addEventListener("touchstart", function(event) {
		if (event.touches.length === 2) {
			event.preventDefault();
			var m = midpoint(event.touches[0], event.touches[1]);
			pinch = {
				d0: distance(event.touches[0], event.touches[1]) || 1,
				s0: scale,
				px: (m.x - tx) / scale,
				py: (m.y - ty) / scale
			};
			pan = null;
		} else if (event.touches.length === 1 && scale > 1.001) {
			event.preventDefault();
			pan = {x: event.touches[0].clientX, y: event.touches[0].clientY, tx: tx, ty: ty};
		}
	}, {passive: false});

	viewport.addEventListener("touchmove", function(event) {
		if (pinch && event.touches.length === 2) {
			event.preventDefault();
			var m = midpoint(event.touches[0], event.touches[1]);
			var next = pinch.s0 * (distance(event.touches[0], event.touches[1]) / pinch.d0);
			scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
			tx = m.x - pinch.px * scale;
			ty = m.y - pinch.py * scale;
			apply();
		} else if (pan && event.touches.length === 1) {
			event.preventDefault();
			tx = pan.tx + (event.touches[0].clientX - pan.x);
			ty = pan.ty + (event.touches[0].clientY - pan.y);
			apply();
		}
	}, {passive: false});

	viewport.addEventListener("touchend", function(event) {
		if (event.touches.length === 0) {
			var wasGesture = pinch !== null || pan !== null;
			var now = Date.now();
			// Double tap anywhere on the map returns to the full view.
			if (!wasGesture && now - lastTap < 300) {
				reset();
				lastTap = 0;
			} else {
				lastTap = now;
			}
			pinch = null;
			pan = null;
		} else if (event.touches.length === 1 && pinch) {
			// Lifting one finger of a pinch hands over to a one-finger pan.
			pinch = null;
			pan = {x: event.touches[0].clientX, y: event.touches[0].clientY, tx: tx, ty: ty};
		}
	});

	// Ctrl/Cmd + wheel zoom, so the same code is testable on a desktop.
	viewport.addEventListener("wheel", function(event) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		var box = viewport.getBoundingClientRect();
		zoomAround(event.clientX - box.left, event.clientY - box.top,
			scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
	}, {passive: false});

	window.addEventListener("resize", apply);
	window.resetMapZoom = reset;
}
