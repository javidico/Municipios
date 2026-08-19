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

Para publicar cambios posteriores basta con:

```bash
git add . && git commit -m "..." && git push
```

La app instalada recoge el cambio **sola**, en el arranque siguiente. Lo explica
la sección de service worker más abajo; el único caso que aún necesita subir
`CACHE_VERSION` en `sw.js` es regenerar los iconos, el overlay o los datos del
mapa.

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
| `outlines/` | Fronteras provinciales precalculadas como vector |
| `icons/` | Iconos generados desde la geometría real del mapa |

## Nitidez del mapa al ampliar

Dos cosas limitaban la calidad al hacer zoom, y ambas están resueltas.

**El zoom rasterizaba.** `will-change: transform` promocionaba el mapa a una capa
de composición rasterizada a la escala inicial, así que ampliar escalaba ese
bitmap en vez de re-renderizar el vector. Ahora el gesto usa `transform` (fluido,
por GPU) y al levantar los dedos se **traslada el zoom al `viewBox` del SVG**, que
fuerza un re-render vectorial a resolución completa. Nítido siempre que estás
mirándolo, que es cuando importa; solo el propio gesto usa el camino rápido.

**El overlay de fronteras era un PNG** de 3538 px estirado sobre el mapa, con
techo de resolución propio. Ahora son paths vectoriales con
`vector-effect="non-scaling-stroke"`, que mantiene la línea con el mismo grosor en
pantalla a cualquier zoom.

## Herramientas de build

Requieren `pillow` y `numpy`. Solo hay que volver a ejecutarlas si cambia
`map.js`.

```bash
python tools/build_icons.py      # iconos, desde la silueta real de España
python tools/build_outlines.py   # overlay de fronteras provinciales
```

`build_outlines.py` calcula las fronteras **topológicamente**, no por píxeles.
Trocea cada polígono municipal en aristas y las clasifica:

- arista usada por dos polígonos de la misma provincia → interior, se descarta;
- usada por dos polígonos de provincias distintas → frontera provincial;
- usada una sola vez → borde exterior: costa o frontera nacional.

Lo que lo hace viable es que el **86% de las aristas aparecen exactamente dos
veces**: la geometría comparte vértices de verdad, no son trazados
independientes. De 1.003.950 aristas únicas quedan 224.792, que se encadenan en
polilíneas y se simplifican con Douglas-Peucker. La simplificación no es solo por
tamaño: el original es un trazado ráster de escalones de 0,1 unidades, y
colapsarlos es lo que hace que las fronteras se vean limpias y no pixeladas.

Resultado: 275 KB (70 KB gzipped, menos que el PNG que sustituyó) y sin techo de
resolución. Además queda **completo**: la versión ráster se perdía las fronteras
entre provincias vecinas que compartían uno de los cuatro colores del mapa.

Hay un filtro `MIN_EXTENT`: el mapa contiene miles de micro-polígonos —`path3` es
un cuadrado de 0,09 × 0,075 unidades— cuyas aristas son frontera legítima pero se
ven como moteado por las provincias. No es un problema de encaje de vértices:
pasar `QUANT` de 1e-4 a 2e-2 cambia el recuento en menos del 3%, la geometría es
así de pequeña.

`main.js` recae en el cálculo ráster en runtime si el archivo no está, que es el
caso de los mapas de Murcia, Madrid y Cádiz: esos envuelven sus paths en un `<g>`
con `transform` y `clipPath` que el script no implementa.

## Cómo se actualiza la app instalada

Un service worker sirve de caché, así que una app instalada puede quedarse con
código viejo indefinidamente aunque el sitio ya esté actualizado. El fallo es
silencioso: subes un arreglo y el móvil nunca lo ve. Para evitarlo, `sw.js`
reparte los archivos en tres grupos según cómo se comportan al redesplegar:

| Grupo | Qué incluye | Estrategia |
| --- | --- | --- |
| Shell | `index.html`, CSS y los tres JS de lógica, manifest (~50 KB) | Se sirve de caché al instante y se revalida en segundo plano |
| Static | Iconos y overlay de fronteras | Solo de caché |
| Data | `map.js` y `municipios.js` (~17 MB) | Solo de caché |

El shell se actualiza solo: el arranque es instantáneo porque responde la caché,
y la recarga en segundo plano deja la versión nueva lista para **el arranque
siguiente**. Es decir, un cambio tarda un arranque en aparecer, sin tocar nada.

Static y Data no se revalidan nunca, porque reconsultar 17 MB en cada arranque
anularía el propósito. Esos sí necesitan que subas `CACHE_VERSION`.

La revalidación usa `cache: 'no-cache'` a propósito: GitHub Pages envía
`Cache-Control: max-age=600`, así que sin eso la caché HTTP del navegador podría
ocultar un despliegue durante diez minutos.

## Tests

```bash
node tools/test_storage.js quiz-municipios   # 28 pruebas de la capa de datos
node tools/test_sw.js quiz-municipios        # 12 pruebas del service worker
npm install jsdom fake-indexeddb             # solo para los dos siguientes
node tools/test_css.js quiz-municipios       #  4 pruebas de cascada CSS
node tools/test_app.js quiz-municipios       # 41 pruebas de la app completa
```

El test de integración arranca `index.html` de verdad en jsdom con los 16 MB de
mapa y los 8.481 municipios, y comprueba aciertos, normalización de acentos,
duplicados, las ocho ordenaciones, exportar/importar, Borrar, la recuperación del
progreso tras un borrado de `localStorage`, y la matemática del zoom: que un
pinch de 2x divide el `viewBox` por dos sin desplazar el centro, que el
`transform` se suelta al confirmar y que el zoom está acotado en ambos extremos.

`test_sw.js` es el que cubre lo de arriba contra un mock de la Cache API:
comprueba que un redespliegue del shell entra solo, que los 17 MB no se vuelven
a pedir, y que sin conexión la app sigue arrancando.

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
