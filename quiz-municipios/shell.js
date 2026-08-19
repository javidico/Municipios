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
// A one-finger drag is left to the browser: panning the zoomed map IS scrolling
// the viewport. That matters for more than tidiness, because panning with a
// transform cannot work here -- the svg only paints what its viewBox covers, so
// sliding it sideways would reveal blank space rather than the neighbouring part
// of Spain. Native scrolling also brings momentum and edge-handoff for free.
//
// Two fingers zoom AND pan at once, the way a map is expected to behave. While
// they are down the view is previewed with a transform, because resizing the box
// mid-gesture would relayout and repaint 13,904 paths every frame; the real size
// and scroll offset are committed when the fingers come up.
function setupMapZoom() {
	var viewport = document.getElementById("mapViewport");
	var map = document.getElementById("mapSvg");
	if (!viewport || !map) return;

	var MAX_ZOOM = 14;
	var zoom = 1;
	var aspect = null;    // viewBox height / width
	var gesture = null;
	var lastTap = 0;

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

	// Move the content point `anchor` (in map pixels at the current zoom) to the
	// viewport position `target`, at the new zoom level.
	function applyZoom(next, anchor, target) {
		var wanted = Math.max(1, Math.min(MAX_ZOOM, next));
		var k = wanted / zoom;
		zoom = wanted;
		if (!relayout()) return;
		scrollTo(anchor.x * k - target.x, anchor.y * k - target.y);
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

	// Where the fingers are, in viewport coordinates.
	function centroid(touches) {
		var box = viewport.getBoundingClientRect();
		var x = 0, y = 0;
		for (var i = 0; i < touches.length; i++) {
			x += touches[i].clientX;
			y += touches[i].clientY;
		}
		return {x: x / touches.length - box.left, y: y / touches.length - box.top};
	}

	/* --- preview transform, live while fingers are down --------------------- */

	function previewTransform() {
		var s = gesture.scale;
		var vw = viewport.clientWidth;
		var vh = viewport.clientHeight;
		var cw = map.offsetWidth * s;
		var ch = map.offsetHeight * s;

		// Hold the anchored content point under the fingers:
		//   screen = content * s + t - scroll
		var tx = gesture.at.x + gesture.scroll.x - gesture.anchor.x * s;
		var ty = gesture.at.y + gesture.scroll.y - gesture.anchor.y * s;

		// ...but never far enough to drag the map off its own edges, which would
		// only snap back on commit. s >= 1/zoom guarantees the map still covers the
		// viewport, so these ranges are never empty.
		tx = Math.min(gesture.scroll.x, Math.max(vw + gesture.scroll.x - cw, tx));
		ty = Math.min(gesture.scroll.y, Math.max(vh + gesture.scroll.y - ch, ty));

		map.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + s + ")";
		gesture.tx = tx;
		gesture.ty = ty;
	}

	// Re-derive the gesture's invariants from whatever is on screen right now.
	// Called whenever the set of fingers changes, so adding or lifting one never
	// makes the map jump: the content currently under the fingers stays there.
	function anchorTo(touches) {
		var at = centroid(touches);
		var s = gesture.scale;
		gesture.at = at;
		gesture.anchor = {
			x: (at.x + gesture.scroll.x - gesture.tx) / s,
			y: (at.y + gesture.scroll.y - gesture.ty) / s
		};
		gesture.spread = touches.length > 1 ? (distance(touches[0], touches[1]) || 1) : null;
		gesture.scaleAtAnchor = s;
	}

	function beginGesture(touches) {
		// Read the scroll offset before freezing overflow, and set will-change only
		// for the duration: left on permanently it pins a rasterised layer and the
		// map never sharpens back up.
		gesture = {
			scroll: {x: viewport.scrollLeft, y: viewport.scrollTop},
			scale: 1,
			tx: 0,
			ty: 0
		};
		viewport.classList.add("gesturing");
		anchorTo(touches);
	}

	function updateGesture(touches) {
		if (!gesture) return;
		gesture.at = centroid(touches);
		if (touches.length > 1 && gesture.spread) {
			var raw = gesture.scaleAtAnchor * (distance(touches[0], touches[1]) / gesture.spread);
			// Bounded to the same range the commit allows, so the preview can never
			// show something that then springs back.
			gesture.scale = Math.max(1 / zoom, Math.min(MAX_ZOOM / zoom, raw));
		}
		previewTransform();
	}

	function endGesture() {
		viewport.classList.remove("gesturing");
		if (!gesture) return;
		var g = gesture;
		gesture = null;
		map.style.transform = "";
		// The anchored content point should end up wherever the fingers left it.
		applyZoom(zoom * g.scale, g.anchor, g.at);
	}

	/* --- events ------------------------------------------------------------- */

	viewport.addEventListener("touchstart", function(event) {
		if (event.touches.length >= 2) {
			event.preventDefault();
			if (gesture) {
				anchorTo(event.touches);      // a finger joined mid-gesture
			} else {
				beginGesture(event.touches);
			}
		}
		// One finger is deliberately left alone: that is the browser scrolling the
		// viewport, which is what pans the map.
	}, {passive: false});

	viewport.addEventListener("touchmove", function(event) {
		if (!gesture) return;
		event.preventDefault();
		updateGesture(event.touches);
	}, {passive: false});

	viewport.addEventListener("touchend", function(event) {
		if (gesture) {
			if (event.touches.length === 0) {
				endGesture();
				lastTap = 0;
			} else {
				// Still a finger on the glass: carry on panning with it rather than
				// dropping the gesture, which is what makes pinch-then-drag feel like
				// one continuous movement.
				anchorTo(event.touches);
				previewTransform();
			}
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
		if (gesture) endGesture();
	});

	// Ctrl/Cmd + wheel zoom, so the same code path is reachable on a desktop.
	viewport.addEventListener("wheel", function(event) {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		var box = viewport.getBoundingClientRect();
		var at = {x: event.clientX - box.left, y: event.clientY - box.top};
		var anchor = {x: viewport.scrollLeft + at.x, y: viewport.scrollTop + at.y};
		applyZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), anchor, at);
	}, {passive: false});

	window.addEventListener("resize", function() {
		// Keep the zoom, resize the boxes to the new width, and pull the scroll
		// offset back inside the new bounds.
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
			transform: map.style.transform,
			gesturing: gesture !== null
		};
	};
}
