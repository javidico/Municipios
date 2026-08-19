# Quiz Municipios — versión instalable en iPhone

App web instalable (PWA) del juego de municipios españoles. Se añade a la
pantalla de inicio del iPhone, arranca a pantalla completa sin barra de
navegador, funciona sin conexión y no pierde el progreso.

Juego original de [jorgeduarte22](https://github.com/jorgeduarte22/quiz-municipios).
Datos de Wikipedia y del [IGN](https://www.ign.es/web/ign/portal/rcc-nomenclator-nacional).

## Por qué se perdía el progreso

No era un bug del juego: Safari en iOS **borra todo el almacenamiento de un
sitio tras 7 días sin visitarlo**. Las webs añadidas a la pantalla de inicio
están exentas de esa purga, así que instalarla es la solución real. Además se
añadieron dos capas más:

1. Un espejo en IndexedDB, que restaura el progreso si `localStorage` se pierde
   o se corrompe.
2. Exportar / importar copia, la única copia que sobrevive a todo: reinstalar la
   app, cambiar de móvil o mover la app a otra URL.

## Desplegar en GitHub Pages

Hace falta HTTPS: sin él el navegador no registra el service worker y la app no
se puede instalar. GitHub Pages lo da gratis.

El repo es <https://github.com/javidico/Municipios>. Para subirlo:

```bash
git remote add origin https://github.com/javidico/Municipios.git
git push -u origin main
```

Luego, una vez y a mano en la web del repo:
**Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.

En un par de minutos la app queda en:

```
https://javidico.github.io/Municipios/quiz-municipios/
```

La raíz `https://javidico.github.io/Municipios/` redirige ahí, así que cualquiera
de las dos sirve. Todas las rutas son relativas y el `scope` del manifest es
`./`, así que la app funciona en cualquier subcarpeta; si algún día quieres la
URL corta, basta mover el contenido de `quiz-municipios/` a la raíz del repo.

Para publicar cambios posteriores: `git add . && git commit -m "..." && git push`.
Si tocas archivos ya cacheados, sube `CACHE_VERSION` en `sw.js` o los
dispositivos seguirán sirviendo la copia vieja.

## Instalar en el iPhone

1. Abre la URL en **Safari** (no vale Chrome: en iOS solo Safari instala PWAs).
2. Botón **Compartir** → **Añadir a pantalla de inicio**.
3. Ábrela desde el icono nuevo, no desde Safari.

Sabrás que está bien instalada porque desaparece la barra del navegador y el
aviso azul de instalación.

## Traer el progreso desde el sitio original

El progreso vive en el `localStorage` de `jorgeduarte22.github.io`, que es otro
origen distinto: no se hereda solo. Para moverlo hay que copiarlo a mano.

**Desde un ordenador** (lo más fácil): abre el sitio original, la consola del
navegador, y ejecuta `localStorage.state`. Copia el resultado completo, ábre tu
app nueva y pulsa **Importar copia**.

**Desde el iPhone**, con un bookmarklet. Crea un marcador cuya dirección sea
esta línea entera, ponle nombre "Exportar municipios" y guárdalo en Favoritos:

```
javascript:(function(){var s=localStorage.getItem('state');if(!s){alert('No hay progreso guardado en este sitio.');return}var t=document.createElement('textarea');t.value=s;t.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;font-size:16px';document.body.appendChild(t);t.focus();t.setSelectionRange(0,s.length);alert(s.length+' bytes listos. Manten pulsado y elige Copiar.')})()
```

Después: abre el sitio original en Safari, toca la barra de direcciones, elige el
marcador desde Favoritos, copia el texto que aparece y pégalo en **Importar
copia** de tu app.

La importación **suma** municipios a los que ya tengas, nunca los sustituye.

## Estructura

| Archivo | Qué hace |
| --- | --- |
| `index.html` | Página, metadatos de instalación e iconos |
| `main.js` | Lógica del juego (del proyecto original, con retoques) |
| `shell.js` | Instalación, copia/restauración y zoom del mapa |
| `storage.js` | Persistencia: localStorage, espejo IndexedDB, exportar/importar |
| `sw.js` | Service worker: arranque instantáneo y modo sin conexión |
| `map.js` | Los 4 mapas SVG (16 MB; España son 13.904 paths) |
| `municipios.js` | 8.481 entradas con nombre, provincia, población y área |
| `outlines/` | Overlay de fronteras provinciales precalculado |
| `icons/` | Iconos generados desde la geometría real del mapa |

## Herramientas de build

Requieren `pillow` y `numpy`. Solo hay que volver a ejecutarlas si cambia
`map.js`.

```bash
python tools/build_icons.py      # iconos, desde la silueta real de España
python tools/build_outlines.py   # overlay de fronteras provinciales
```

`build_outlines.py` existe por rendimiento. En origen, el overlay se calculaba en
cada arranque: serializar los 15 MB de SVG, rasterizarlos a 3538x2013 y recorrer
**7,1 millones de píxeles** en JavaScript. El resultado nunca cambia (el SVG
serializado solo lleva sus atributos de presentación, así que la regla
`.selected` no se aplica), de modo que ahora se genera una vez y se sirve como un
PNG de 80 KB. `main.js` recae en el cálculo en runtime si el archivo no está, que
es el caso de los mapas de Murcia, Madrid y Cádiz: esos envuelven sus paths en un
`<g>` con `transform` y `clipPath` que el script no implementa.

## Tests

```bash
node tools/test_storage.js quiz-municipios   # 28 pruebas de la capa de datos
npm install jsdom fake-indexeddb             # solo para el test de integración
node tools/test_app.js quiz-municipios       # 27 pruebas de la app completa
```

El test de integración arranca `index.html` de verdad en jsdom con los 16 MB de
mapa y los 8.481 municipios, y comprueba aciertos, normalización de acentos,
duplicados, ordenaciones, exportar/importar, Borrar y la recuperación del
progreso tras un borrado de `localStorage`.

## Servidor local

```bash
python quiz-municipios/server.py 8177
```

Sirve en `http://127.0.0.1:8177` con los Content-Type correctos. Sirve para
probar en el ordenador, pero **no** para instalar en el iPhone: para eso hace
falta HTTPS.

## Cambios sobre el original

Además de la capa PWA:

- `<! DOCTYPE html>` llevaba un espacio, lo que activaba quirks mode, y el
  `<meta viewport>` estaba fuera del `<head>`.
- El `input` tenía `font-size: 13px`. Cualquier valor menor que 16px hace que
  iOS haga zoom automático al enfocar el campo.
- `var state = INITIAL_STATE` aliasaba el objeto "inicial", así que la primera
  respuesta correcta lo mutaba y dejaba de servir como valor de reserva.
- El botón Borrar llamaba a `loadPage()` completo, que volvía a registrar todos
  los listeners: cada pulsación duplicaba los manejadores. Ahora solo redibuja,
  y pide confirmación antes de borrar.
