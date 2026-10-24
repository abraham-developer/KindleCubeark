# KindleCubeark

Lector web multiusuario para PDF y EPUB, estilo Kindle: subes libros, se parsean
(PDF con pdf-lib, EPUB con adm-zip), se leen en el navegador con retomado
exacto de posición y anotaciones (resaltados, notas y marcadores por libro).

Especificación completa: `docs/superpowers/specs/2026-09-27-kindle-reader-design.md`

## Stack

- **API**: Fastify 4 + Postgres 16 (pg), sesiones firmadas con `@fastify/secure-session`, subidas con `@fastify/multipart`.
- **SPA**: React 18 + Vite + react-router; lectores con `pdfjs-dist` (PDF) y `epubjs` (EPUB).
- **Despliegue**: imagen Docker única (API sirve el SPA), compose para dev y Docker Swarm en producción detrás de traefik.

## Estructura del repo

```
apps/api/          API Fastify (src/, test/ en vitest, migrations/ en SQL)
apps/web/          SPA React (src/, tests en vitest + jsdom)
deploy/swarm.yml   stack de producción para Docker Swarm
Dockerfile         build multi-stage (web + api + runtime, un solo Dockerfile)
docker-compose.yml entorno de desarrollo (db postgres + app)
```

## Desarrollo

Con Docker (recomendado):

```sh
docker compose up -d          # db en :5432 (kindle/kindle) + app en :3000
curl -s localhost:3000/api/health   # → {"ok":true}
```

O a mano (necesita Postgres en `localhost:5432`, usuario `kindle`, clave `kindle`):

```sh
# .env.local en la raíz con:
# DATABASE_URL=postgres://kindle:kindle@localhost:5432/kindle
# SESSION_SECRET=<exactamente 32 bytes (32 caracteres hex: openssl rand -hex 16)>
cd apps/api && npm install && npm run dev    # API en :3000 (migra sola al arrancar)
cd apps/web && npm install && npm run dev    # Vite en :5173 con proxy /api → :3000
```

Las migraciones corren solas al arrancar la API (`RUN_MIGRATIONS=false` para desactivar).

## Tests

La base Postgres debe estar levantada (la del compose sirve):

```sh
cd apps/api && npx vitest run     # API (requiere Postgres en :5432)
cd apps/web && npx vitest run     # SPA (jsdom, no requiere servicios)
```

## Producción en Docker Swarm

Objetivo: dominio `kindle.cubeark.dev` servido por traefik (ya corre en el swarm
unido a la red overlay `admin`, entrypoint `websecure` + certresolver
`letsencryptresolver`). La app **no publica puertos al host**: traefik la alcanza
por la red `admin`. Postgres vive dentro del stack, solo en una red interna
cifrada, con la contraseña y el secreto de sesión como **docker secrets** (no hay
contraseñas en el repo).

### 1. Clonar el repo en el manager

```sh
ssh <manager>
git clone <url-del-repo> kindleCubeark && cd kindleCubeark
```

### 2. Crear los secrets

```sh
openssl rand -hex 32 | docker secret create kindle_db_password -
openssl rand -hex 16 | docker secret create kindle_session_secret -
docker secret ls
```

(`kindle_session_secret` debe tener EXACTAMENTE 32 bytes: es la clave de
`@fastify/secure-session`; uno más corto lanza «key must be 32 bytes» y uno
más largo se trunca silenciosamente a 32. `openssl rand -hex 16` produce
32 caracteres hex = 32 bytes.)

### 3. Build y etiquetado de la imagen (en el manager)

```sh
podman build -t kindlecubeark:latest .          # o docker build
podman tag kindlecubeark:latest kindlecubeark:v1 # etiqueta por release si quieres
```

> Con podman, `--format docker` preserva el `HEALTHCHECK` del Dockerfile (el
> formato OCI lo ignora); el swarm.yml define igualmente el healthcheck a nivel
> de servicio, que es el que Docker usa en el stack.

La imagen queda en el almacén local del manager (`deploy/swarm.yml` usa
`image: kindlecubeark:latest` y el servicio tiene constraint
`node.role == manager`). Para un swarm multi-nodo, sube la imagen a un
registry y cambia la línea `image:` de `deploy/swarm.yml`.

### 4. DNS

`kindle.cubeark.dev` → IP del nodo manager (la misma entrada que usa traefik).

### 5. Deploy

```sh
docker network ls | grep admin    # la red overlay debe existir (traefik)
docker stack deploy -c deploy/swarm.yml kindle
```

### 6. Verificación

```sh
docker service ls                 # kindle_app y kindle_db en 1/1
docker service ps kindle_app      # sin restarts
docker exec -it $(docker ps -qf name=kindle_app) \
  node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
# → {"ok":true}  (las migraciones corren solas en el primer arranque)
```

Desde afuera: `https://kindle.cubeark.dev` (traefik emite el cert con
letsencryptresolver). La primera petición puede tardar mientras se emite el certificado.

### 7. Rolling update

```sh
# tras hacer build de la nueva imagen:
podman build -t kindlecubeark:v2 .
docker service update --image kindlecubeark:v2 kindle_app
# con order start-first + failure_action rollback, un healthcheck fallido revierte solo
```

## Smoke manual (por release)

Subir un PDF y un EPUB, leerlos, anotar (resaltado/nota/marcador), cerrar,
reabrir → la lectura retoma en la posición exacta y las anotaciones siguen.
Luego `docker service update --image kindlecubeark:v2 kindle_app` y repetir el
retomado sobre la nueva réplica.

## Configuración de la app (variables)

| Variable | Uso |
|---|---|
| `DATABASE_URL` | URL de Postgres en claro (compose dev). Si no está, la API arma la URL con `DB_HOST`/`DB_USER`/`DB_NAME` + contraseña leída de `DB_PASSWORD_FILE` (docker secret). En producción sin ninguna de las dos, el arranque falla. |
| `SESSION_SECRET` | Clave de sesiones, EXACTAMENTE 32 bytes (32 caracteres hex, `openssl rand -hex 16`); `@fastify/secure-session` lanza «key must be 32 bytes» con otra longitud. En claro (dev); en producción se lee de `SESSION_SECRET_FILE` (docker secret); sin archivo ni env, el arranque falla. |
| `DATA_DIR` | Directorio de libros y covers (default `/data`, volumen `kindle_book_data`). |
| `MAX_UPLOAD_MB` | Límite de subida (default `100`). Es el cap real de archivos: `bodyLimit` de Fastify no aplica a multipart, el toque de tamaño lo pone `limits.fileSize` de @fastify/multipart con este valor. |
| `WEB_DIST` | Directorio del build SPA (default `web/dist` relativo al runtime). |
| `PORT` | Puerto de la API (default `3000`). |
| `RUN_MIGRATIONS` | `false` para desactivar la migración al arrancar. |
| `LIBRETRANSLATE_URL` | URL base de LibreTranslate (motor open source autohospedado) para el modo estudio bilingüe. Sin esta variable, el estudio muestra «Traducción no disponible». En dev: `docker compose --profile translate up -d` y `LIBRETRANSLATE_URL=http://localhost:5000` (el compose ya lo apunta al servicio `translate`). |

## Lectura por bloques y estudio bilingüe (PDF)

El lector PDF tiene dos vistas (se cambian en la barra de opciones):

- **Página**: la hoja completa, como antes.
- **Bloques**: cada página se parte en minilecturas estilo Kindle; el progreso
  se guarda a nivel de bloque (`{page, block, blockCount}`), así que al
  reabrir retomas el bloque exacto.

El **estudio bilingüe** es opcional y vive sobre la vista por bloques:
intercala pantallas completas —un bloque en original, el mismo traducido
(inglés, francés, alemán, chino o español), y así— para estudiar el idioma mientras
lees (las imágenes ocupan una sola pantalla, no se traducen). El progreso
se guarda por pantalla (`{page, block, blockCount, face}`) y al reabrir
retomas la exacta; al desactivarlo vuelves a lectura normal en el mismo
bloque. Traduce con
LibreTranslate autohospedado (Argos Translate, 100% open source y offline);
la app lo usa por `POST /api/translate`, que valida sesión y reenvía al
motor.

## Biblioteca de tinta y búsqueda predictiva

La biblioteca ya no es una estantería: es una **cuadrícula minimalista para
pantalla de tinta** — celdas planas en blanco y gris separadas por líneas
suaves de 1 px, sin madera, sin sombras ni elevaciones (2 columnas en
teléfono). La búsqueda es **predictiva**: al escribir muestra sugerencias
ordenadas (primero el título que empieza por lo escrito) sin distinguir
acentos ni mayúsculas («garcia» encuentra a García Márquez); tocar una
sugerencia abre el libro, y con ↑/↓ + Enter se elige desde el teclado.
Sirve en «Mis libros» y en la «Biblioteca global».

## Pronunciación por bloques (estudio)

Con el estudio bilingüe activo, bajo cada bloque de texto (solo vista por
bloques) hay un panel **Pronunciación**, pensado como práctica estilo
estudio. Sin estudio activo el panel no aparece. La pareja de idiomas sale
del propio modo bilingüe, sin selectores extra: el original por defecto y
el idioma de traducción ya elegido en la barra de estudio.

- **Escuchar original**, **Escuchar traducción** y **Escuchar ambos**
  (primero un idioma y al terminar el otro).
- **Cómo se pronuncia**: guía fonética escrita de referencia de las
  primeras palabras del bloque en ambos idiomas — sílabas en español
  («ho·la») y transcripción aproximada con sonidos del español para
  inglés, francés y alemán — para escuchar, repetir y comparar.

Todo es gratuito y sin cuentas: la voz es la **síntesis integrada del
navegador** (Web Speech API; las voces las pone el sistema operativo) y la
guía se genera en el propio navegador. Sin claves, sin backend de audio y
sin servicios de pago. Si el navegador no trae voz, el panel lo avisa y la
guía escrita sigue disponible. Al cambiar de bloque la lectura se detiene.

El **modo typing** (solo escritorio, con teclado físico) convierte el texto
de cada libro en práctica palabra por palabra estilo typing.com: lecciones
de 30 palabras, PPM y precisión en vivo, puntuación al cerrar cada lección
y retomado exacto por libro. Incluye modo bilingüe con glosa de la palabra
actual y traducción de la lección (también al francés), teclado en pantalla
según el layout elegido (QWERTY español/inglés, AZERTY francés, QWERTZ
alemán o Dvorak) con dedo sugerido, y el historial de puntuaciones por
libro guardado en el servidor (`typing_progress` / `typing_scores`). Se
entra desde el menú `⋯` de cada libro → «Modo typing (escritorio)», y
también dentro del lector con el botón «Typing» de la barra de lectura:
ahí la práctica va sobre la hoja en lectura, siempre en vista por bloques
y a mitad de pantalla (en EPUB, centrada sobre la sección actual), con
puntuación guardada por libro al completar cada hoja.

En la vista por bloques, cada página se separa por posición: el texto va
como bloques refluidos y cada imagen ocupa su propio bloque, intercalados
en orden de lectura (texto, imagen, texto…). Las páginas escaneadas se
leen como bloques-imagen. La lectura usa estilo hoja de papel (tarjeta
elevada en escritorio, a sangre en teléfono).

**Diccionario**: mantén presionada una palabra con el dedo (o con el mouse)
y se marca en azul con su significado en un popover: glosas en español del
Wikcionario (que cubre palabras extranjeras) con respaldo en inglés. No abre
el menú de resaltado; para resaltar en táctil selecciona con doble toque y
arrastra los tiradores como siempre. En modo estudio bilingüe muestra ambos
significados (español + inglés). Requiere internet (consulta directa a
Wikimedia).