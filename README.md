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
bitmap en vez de re-renderizar el vector. Ahora el zoom **agranda la caja CSS del
SVG** manteniendo su `viewBox`, de modo que el vector se re-renderiza al tamaño
nuevo y queda nítido a cualquier aumento. Durante el pellizco sí se usa un
`transform` como vista previa —redimensionar la caja en cada frame relayoutearía y
repintaría 13.904 paths— y al soltar se confirma el tamaño real.

**El desplazamiento es el scroll nativo del navegador.** No es solo por
comodidad: arrastrar con `transform` no puede funcionar aquí, porque el SVG solo
pinta lo que cubre su `viewBox`, así que moverlo de lado revelaría hueco vacío en
vez del trozo de país contiguo. Ese fue justo el fallo de la primera versión, que
además clampaba el desplazamiento contra un contenedor del mismo ancho y lo
forzaba a cero. Con scroll nativo salen gratis la inercia y el traspaso al scroll
de la página al llegar al borde.

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

`build_outlines.py` calcula las fronteras en dos fases. Una frontera es donde la
provincia de un lado difiere de la del otro; parece obvio, pero las lecturas
ingenuas de esa frase fallan todas.

**Fase 1, barata.** Se trocea cada polígono municipal en aristas, cuantizadas para
que los vértices compartidos coincidan. Una arista usada por dos polígonos de la
misma provincia no puede ser frontera de ninguna forma: eso elimina 786.034 de
1.003.950. Lo que hace viable todo esto es que el **86% de las aristas aparecen
exactamente dos veces**, o sea que la geometría comparte vértices de verdad.

**Fase 2, la que decide.** El resto son solo candidatas, y contar usos no basta:

- *"usada una vez, luego es borde exterior"* es falso. Dibujaba contornos
  espurios alrededor de municipios de interior normales (Buñol, La Gineta,
  Alustante) cuyos polígonos no comparten aristas con sus vecinos. Se veían como
  agujeros dentro de su propia provincia.
- *"dos polígonos con provincias distintas, luego es frontera"* también es falso.
  Si un polígono queda tapado por otro, la provincia declarada no es la que se
  ve, y la línea aparece en medio de una provincia de un solo color.

Así que se rasterizan las provincias en un mapa de índices y cada candidata se
muestrea un par de píxeles a cada lado: sobrevive solo si los dos lados difieren.
La costa se queda (provincia contra mar), una frontera real se queda, y un
municipio rodeado por su propia provincia se descarta. Tras eso, ningún bucle
cerrado tiene la misma provincia a ambos lados y los únicos enclaves que quedan
son los reales: Treviño, Orduña, Petilla de Aragón.

Después se encadenan en polilíneas y se simplifican con Douglas-Peucker. Eso
último no es solo por tamaño: el original es un trazado ráster de escalones de 0,1
unidades, y colapsarlos es lo que hace que se vean limpias y no pixeladas.

Resultado: 265 KB (88 KB gzipped, en línea con el PNG que sustituyó) y sin techo
de resolución. Además queda **completo**: la versión ráster se perdía las
fronteras entre provincias vecinas que compartían uno de los cuatro colores.

Hay un filtro `MIN_EXTENT`: el mapa contiene miles de micro-polígonos —`path3` es
un cuadrado de 0,09 × 0,075 unidades— cuyas aristas son frontera legítima pero se
ven como moteado por las provincias. No es un problema de encaje de vértices:
pasar `QUANT` de 1e-4 a 2e-2 cambia el recuento en menos del 3%, la geometría es
así de pequeña.

Las provincias se leen parseando `municipios.js` de verdad, no con un regex. Uno
que exigía que `"provincia"` fuese seguido de `"population"` se dejaba 82 paths
en silencio, y esos 82 hacían doble daño: cada uno recibía una provincia propia,
así que sus aristas contra vecinos legítimos contaban como frontera, y al
rasterizar se omitían, dejando huecos de «mar» falso dentro de Burgos o
Guadalajara. (El parse necesita normalizar dos rarezas del archivo: comas
sobrantes y un `"population": 717.` con el punto colgando.)

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
node tools/test_app.js quiz-municipios       # 44 pruebas de la app completa
```

El test de integración arranca `index.html` de verdad en jsdom con los 16 MB de
mapa y los 8.481 municipios, y comprueba aciertos, normalización de acentos,
duplicados, las ocho ordenaciones, exportar/importar, Borrar, la recuperación del
progreso tras un borrado de `localStorage`, y la mecánica del zoom: que un pinch
de 2x duplica la caja del mapa, que **queda sitio real para desplazarse en
horizontal**, que el punto focal no se mueve bajo los dedos, que el `transform` se
suelta al confirmar y que un toque de un solo dedo no se intercepta —si se
interceptara, el mapa dejaría de desplazarse.

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
