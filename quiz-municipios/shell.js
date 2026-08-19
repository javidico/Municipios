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

/* --- map pinch zoom and pan ----------------------------------------------- */

// The map is zoomed by growing the svg's CSS box while its viewBox stays the
// whole country. The vector is then rendered at the larger size, so it is sharp
// at any magnification, and the viewport simply clips it.
//
// Panning is the browser's own scrolling. That matters for more than tidiness:
// panning with a transform cannot work here, because the svg only paints what
// its viewBox covers, so sliding it sideways reveals blank space rather than the
// neighbouring part of Spain. Native scrolling also brings momentum and
// edge-handoff to the page for free.
//
// A pinch still uses a transform while the fingers are down -- resizing the box
// mid-gesture would relayout and repaint 13,904 paths every frame -- and commits
// to a real size on release.
function setupMapZoom() {
	var viewport = document.getElementById("mapViewport");
	var map = document.getElementById("mapSvg");
	if (!viewport || !map) return;

	var MAX_ZOOM = 14;
	var zoom = 1;
	var aspect = null;    // viewBox height / width
	var pinch = null;
	var lastTap = 0;
	var wheelTimer = null;

	function readAspect() {
		if (aspect) return aspect;
		var svg = map.querySelector("svg");
		if (!svg) return null;
		var vb = svg.viewBox.baseVal;
		if (!vb || !vb.width) return null;
		aspect = vb.height / vb.width;
		return aspect;
	}

	// The viewport keeps the unzoomed map's shape; the map inside it grows.
	function relayout() {
		if (!readAspect()) return false;
		var base = viewport.clientWidth;
		if (!base) return false;
		viewport.style.height = (base * aspect) + "px";
		map.style.width = (base * zoom) + "px";
		map.style.height = (base * zoom * aspect) + "px";
		viewport.classList.toggle("zoomed", zoom > 1.001);
		return true;
	}

	function maxScrollX() {
		return Math.max(0, map.offsetWidth - viewport.clientWidth);
	}

	function maxScrollY() {
		return Math.max(0, map.offsetHeight - viewport.clientHeight);
	}

	function scrollTo(x, y) {
		viewport.scrollLeft = Math.max(0, Math.min(maxScrollX(), x));
		viewport.scrollTop = Math.max(0, Math.min(maxScrollY(), y));
	}

	// Change the zoom, keeping the content under (fx, fy) -- viewport coordinates
	// -- exactly where it is.
	function zoomTo(next, fx, fy, scroll0) {
		var target = Math.max(1, Math.min(MAX_ZOOM, next));
		var k = target / zoom;
		zoom = target;
		if (!relayout()) return;
		scrollTo((scroll0.x + fx) * k - fx, (scroll0.y + fy) * k - fy);
	}

	function reset() {
		zoom = 1;
		map.style.transform = "";
		if (relayout()) scrollTo(0, 0);
	}

	function distance(a, b) {
		var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function focalPoint(a, b) {
		var box = viewport.getBoundingClientRect();
		return {
			x: (a.clientX + b.clientX) / 2 - box.left,
			y: (a.clientY + b.clientY) / 2 - box.top
		};
	}

	function beginPinch(a, b) {
		// overflow is frozen for the duration so the scroll offset cannot drift
		// under the transform, and will-change is only set here: left on
		// permanently it pins a rasterised layer and the map never sharpens up.
		viewport.classList.add("gesturing");
		var focus = focalPoint(a, b);
		pinch = {
			d0: distance(a, b) || 1,
			focus: focus,
			scroll: {x: viewport.scrollLeft, y: viewport.scrollTop},
			scale: 1
		};
	}

	function updatePinch(a, b) {
		if (!pinch) return;
		var raw = distance(a, b) / pinch.d0;
		// Bound the preview to the same range the commit will allow, so the
		// gesture cannot show something that then snaps back.
		var lo = 1 / zoom, hi = MAX_ZOOM / zoom;
		pinch.scale = Math.max(lo, Math.min(hi, raw));

		// Hold the focal point still: content coordinate c renders at
		// c * s + t - scroll, and we want the focal content point back at focus.
		var s = pinch.scale;
		var tx = pinch.focus.x + pinch.scroll.x - (pinch.scroll.x + pinch.focus.x) * s;
		var ty = pinch.focus.y + pinch.scroll.y - (pinch.scroll.y + pinch.focus.y) * s;
		map.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + s + ")";
	}

	function endPinch() {
		viewport.classList.remove("gesturing");
		if (!pinch) return;
		var p = pinch;
		pinch = null;
		map.style.transform = "";
		zoomTo(zoom * p.scale, p.focus.x, p.focus.y, p.scroll);
	}

	viewport.addEventListener("touchstart", function(event) {
		if (event.touches.length === 2) {
			event.preventDefault();
			beginPinch(event.touches[0], event.touches[1]);
		}
		// One finger is deliberately left alone: that is the browser scrolling the
		// viewport, which is what pans the map.
	}, {passive: false});

	viewport.addEventListener("touchmove", function(event) {
		if (pinch && event.touches.length === 2) {
			event.preventDefault();
			updatePinch(event.touches[0], event.touches[1]);
		}
	}, {passive: false});

	viewport.addEventListener("touchend", function(event) {
		if (pinch && event.touches.length < 2) {
			endPinch();
			lastTap = 0;
			return;
		}
		if (event.touches.length === 0) {
			var now = Date.now();
			// Double tap anywhere on the map returns to the full view.
			if (now - lastTap < 300) {
				reset();
				lastTap = 0;
			} else {
				lastTap = now;
			}
		}
	});

	viewport.addEventListener("touchcancel", function() {
		if (pinch) endPinch();
	});

	// Ctrl/Cmd + wheel zoom, so the same code path is reachable on a desktop.
	viewport.addEventListener("wheel", function(event) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		var box = viewport.getBoundingClientRect();
		var fx = event.clientX - box.left;
		var fy = event.clientY - box.top;
		var scroll = {x: viewport.scrollLeft, y: viewport.scrollTop};
		zoomTo(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), fx, fy, scroll);
		if (wheelTimer) clearTimeout(wheelTimer);
		wheelTimer = setTimeout(function() { wheelTimer = null; }, 180);
	}, {passive: false});

	window.addEventListener("resize", function() {
		// Keep the zoom level, resize the boxes to the new width, and pull the
		// scroll offset back inside the new bounds.
		var scroll = {x: viewport.scrollLeft, y: viewport.scrollTop};
		if (relayout()) scrollTo(scroll.x, scroll.y);
	});

	relayout();

	window.resetMapZoom = reset;
	window.mapZoomState = function() {
		return {
			zoom: zoom,
			width: map.offsetWidth,
			height: map.offsetHeight,
			viewportWidth: viewport.clientWidth,
			scrollLeft: viewport.scrollLeft,
			scrollTop: viewport.scrollTop,
			maxScrollX: maxScrollX(),
			maxScrollY: maxScrollY(),
			transform: map.style.transform
		};
	};
}
