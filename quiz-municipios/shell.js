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

// Zoom happens in two stages, because neither one alone works well here.
//
// A CSS transform is cheap and smooth, but the browser rasterises the layer once
// and then scales that bitmap, so the map goes soft exactly when you magnify it
// to read a small municipio. Rewriting the SVG viewBox instead re-renders the
// vector at full resolution and stays perfectly sharp, but it repaints 13,904
// paths, which is far too slow for every frame of a pinch.
//
// So: transform during the gesture, then commit the equivalent viewBox once the
// fingers come up. Sharp whenever you are actually looking at it.
function setupMapZoom() {
	var viewport = document.getElementById("mapViewport");
	var map = document.getElementById("mapSvg");
	if (!viewport || !map) return;

	var MAX_ZOOM = 14;
	var natural = null;              // the map's own viewBox
	var view = null;                 // the committed viewBox, in map units
	var scale = 1, tx = 0, ty = 0;   // gesture transform, on top of `view`
	var pinch = null;
	var pan = null;
	var lastTap = 0;
	var wheelTimer = null;

	function svgEl() {
		return map.querySelector("svg");
	}

	// Resolved lazily: the svg only exists once drawMap() has run, and drawMap
	// replaces it wholesale on every redraw.
	function sync() {
		var svg = svgEl();
		if (!svg) return false;
		var vb = svg.viewBox.baseVal;
		if (!vb || !vb.width) return false;
		if (!natural) {
			natural = {x: vb.x, y: vb.y, w: vb.width, h: vb.height};
			view = {x: vb.x, y: vb.y, w: vb.width, h: vb.height};
			return true;
		}
		// A redraw hands back a pristine svg carrying the original viewBox. Detect
		// that by the viewBox no longer matching the committed view and start over
		// from the full map rather than leaving the two out of step.
		if (Math.abs(vb.width - view.w) > 1e-6 || Math.abs(vb.x - view.x) > 1e-6) {
			if (Math.abs(vb.width - natural.w) < 1e-6) {
				view = {x: vb.x, y: vb.y, w: vb.width, h: vb.height};
				scale = 1; tx = 0; ty = 0;
				map.style.transform = "";
				viewport.classList.remove("zoomed");
			}
		}
		return true;
	}

	function totalZoom() {
		return view ? natural.w / view.w : 1;
	}

	function minGestureScale() {
		return 1 / totalZoom();          // cannot zoom out past the full map
	}

	function maxGestureScale() {
		return MAX_ZOOM / totalZoom();
	}

	function clampTransform() {
		var lo = minGestureScale(), hi = maxGestureScale();
		if (scale < lo) scale = lo;
		if (scale > hi) scale = hi;
		var vw = viewport.clientWidth;
		var vh = viewport.clientHeight;
		var cw = map.offsetWidth * scale;
		var ch = map.offsetHeight * scale;
		tx = cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, tx));
		ty = ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, ty));
	}

	function applyTransform() {
		clampTransform();
		map.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
		viewport.classList.toggle("zoomed", totalZoom() * scale > 1.001);
	}

	function writeViewBox() {
		var svg = svgEl();
		if (!svg) return;
		svg.setAttribute("viewBox",
			view.x + " " + view.y + " " + view.w + " " + view.h);
	}

	// Fold the gesture transform into the viewBox and drop the transform, so the
	// vector is re-rendered at the new scale instead of being a scaled bitmap.
	function commit() {
		if (!sync()) return;
		var w = map.offsetWidth;
		var h = map.offsetHeight;
		if (!w || !h || scale === 1 && tx === 0 && ty === 0) {
			map.style.transform = "";
			return;
		}

		var fx = view.w / w;             // map units per layout pixel
		var fy = view.h / h;
		view = {
			x: view.x - (tx / scale) * fx,
			y: view.y - (ty / scale) * fy,
			w: view.w / scale,
			h: view.h / scale
		};

		// Never wider than the whole map, never narrower than the zoom cap.
		if (view.w > natural.w) {
			view.w = natural.w;
			view.h = natural.h;
		}
		var minW = natural.w / MAX_ZOOM;
		if (view.w < minW) {
			var k = minW / view.w;
			view.w *= k;
			view.h *= k;
		}
		view.x = Math.max(natural.x, Math.min(natural.x + natural.w - view.w, view.x));
		view.y = Math.max(natural.y, Math.min(natural.y + natural.h - view.h, view.y));

		scale = 1; tx = 0; ty = 0;
		writeViewBox();
		map.style.transform = "";
		viewport.classList.toggle("zoomed", totalZoom() > 1.001);
	}

	function reset() {
		if (!sync()) return;
		view = {x: natural.x, y: natural.y, w: natural.w, h: natural.h};
		scale = 1; tx = 0; ty = 0;
		writeViewBox();
		map.style.transform = "";
		viewport.classList.remove("zoomed");
	}

	function beginGesture() {
		// will-change is set only while a gesture runs: left on permanently it pins
		// a rasterised layer and the map never sharpens back up.
		viewport.classList.add("gesturing");
	}

	function endGesture() {
		viewport.classList.remove("gesturing");
		commit();
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

	viewport.addEventListener("touchstart", function(event) {
		if (!sync()) return;
		if (event.touches.length === 2) {
			event.preventDefault();
			beginGesture();
			var m = midpoint(event.touches[0], event.touches[1]);
			pinch = {
				d0: distance(event.touches[0], event.touches[1]) || 1,
				s0: scale,
				px: (m.x - tx) / scale,
				py: (m.y - ty) / scale
			};
			pan = null;
		} else if (event.touches.length === 1 && totalZoom() * scale > 1.001) {
			event.preventDefault();
			beginGesture();
			pan = {x: event.touches[0].clientX, y: event.touches[0].clientY, tx: tx, ty: ty};
		}
	}, {passive: false});

	viewport.addEventListener("touchmove", function(event) {
		if (pinch && event.touches.length === 2) {
			event.preventDefault();
			var m = midpoint(event.touches[0], event.touches[1]);
			var next = pinch.s0 * (distance(event.touches[0], event.touches[1]) / pinch.d0);
			scale = Math.min(maxGestureScale(), Math.max(minGestureScale(), next));
			tx = m.x - pinch.px * scale;
			ty = m.y - pinch.py * scale;
			applyTransform();
		} else if (pan && event.touches.length === 1) {
			event.preventDefault();
			tx = pan.tx + (event.touches[0].clientX - pan.x);
			ty = pan.ty + (event.touches[0].clientY - pan.y);
			applyTransform();
		}
	}, {passive: false});

	viewport.addEventListener("touchend", function(event) {
		if (event.touches.length === 0) {
			var wasGesture = pinch !== null || pan !== null;
			var now = Date.now();
			pinch = null;
			pan = null;
			if (wasGesture) {
				endGesture();
			} else if (now - lastTap < 300) {
				// Double tap anywhere on the map returns to the full view.
				reset();
				lastTap = 0;
				return;
			}
			lastTap = now;
		} else if (event.touches.length === 1 && pinch) {
			// Lifting one finger of a pinch hands over to a one-finger pan.
			pinch = null;
			pan = {x: event.touches[0].clientX, y: event.touches[0].clientY, tx: tx, ty: ty};
		}
	});

	// Ctrl/Cmd + wheel zoom, so the same code path is reachable on a desktop.
	viewport.addEventListener("wheel", function(event) {
		if (!event.ctrlKey && !event.metaKey) return;
		if (!sync()) return;
		event.preventDefault();
		beginGesture();
		var box = viewport.getBoundingClientRect();
		var mx = event.clientX - box.left, my = event.clientY - box.top;
		var px = (mx - tx) / scale, py = (my - ty) / scale;
		var next = scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12);
		scale = Math.min(maxGestureScale(), Math.max(minGestureScale(), next));
		tx = mx - px * scale;
		ty = my - py * scale;
		applyTransform();
		// A wheel has no natural end, so settle shortly after it stops moving.
		if (wheelTimer) clearTimeout(wheelTimer);
		wheelTimer = setTimeout(function() { wheelTimer = null; endGesture(); }, 180);
	}, {passive: false});

	window.addEventListener("resize", function() {
		if (sync()) applyTransform();
	});

	window.resetMapZoom = reset;
	window.mapZoomState = function() {
		return {natural: natural, view: view, scale: scale, tx: tx, ty: ty,
			zoom: totalZoom()};
	};
}
