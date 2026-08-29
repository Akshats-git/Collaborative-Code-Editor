# Built from the repository root, not from this directory: the server depends on
# a workspace package, so the build context has to include both.
#
#   docker build -f apps/server/Dockerfile .

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Install from the root so the workspace symlinks are created. Copying only the
# manifests first keeps this layer cached across source changes.
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/web apps/web
# The web app is built here too. The server serves it, so one image is the
# whole deployment. VITE_WS_URL is deliberately not set, because the client
# defaults to the origin it was served from.
RUN npm run build -w @cce/protocol && npm run build -w @cce/server && npm run build -w @cce/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# Read at runtime by `npm run db:setup`.
COPY apps/server/sql apps/server/sql

USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
