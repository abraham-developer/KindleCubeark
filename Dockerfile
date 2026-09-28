# imagen única kindlecubeark: API Fastify + SPA React servida por la API
# build: podman build -t kindlecubeark:<tag> .   (o docker build)
# NOTA: base Debian (glibc), no alpine — @fastify/secure-session depende de
# sodium-native, que no publica prebuilds musl (no carga en alpine).

# --- build web (SPA React) ---
FROM node:20-slim AS build-web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web /src/apps/web
RUN npm run build

# --- build api (tsc + deps de producción) ---
FROM node:20-slim AS build-api
WORKDIR /src/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
COPY apps/api /src/apps/api
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:20-slim AS runtime
WORKDIR /srv
COPY --from=build-api /src/apps/api/dist ./api/dist
COPY --from=build-api /src/apps/api/node_modules ./api/node_modules
COPY --from=build-api /src/apps/api/package.json ./api/package.json
# migrate.ts resuelve ../migrations desde dist/, el dir debe viajar con la imagen
COPY --from=build-api /src/apps/api/migrations ./api/migrations
COPY --from=build-web /src/apps/web/dist ./web/dist
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 \
    WEB_DIST=web/dist \
    DB_PASSWORD_FILE=/run/secrets/kindle_db_password \
    SESSION_SECRET_FILE=/run/secrets/kindle_session_secret
RUN groupadd -r app && useradd -r -g app app && mkdir -p /data && chown -R app:app /data /srv
USER app
VOLUME /data
EXPOSE 3000
# sin wget en slim: healthcheck con fetch nativo de node 20
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "api/dist/index.js"]