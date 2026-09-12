# syntax=docker/dockerfile:1
#
# Rally, as one deployable: the Node server, the display bundle and the phone
# bundle behind a single origin.
#
# One origin is not a packaging convenience, it is a requirement. The QR code a
# phone scans is built from the origin the display was served from, and iOS hands
# out motion sensors only over HTTPS — so display, phone app and WebSocket all
# have to live behind the same TLS hostname or the pairing flow cannot work at
# all.

# ── Build ─────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so the install layer is rebuilt only when dependencies change
# and an ordinary source edit redeploys without reinstalling anything.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/motion/package.json packages/motion/
COPY packages/sim/package.json packages/sim/
COPY apps/server/package.json apps/server/
COPY apps/display/package.json apps/display/
COPY apps/controller/package.json apps/controller/
RUN npm ci

COPY . .
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    RALLY_SERVE_STATIC=1

# The server runs its TypeScript directly through tsx, which is exactly what
# `npm start` does. Keeping one path means production exercises the same code
# development does, rather than a separately compiled one that only ever runs
# where nobody is watching.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.base.json /app/tsconfig.json /app/tsconfig.node.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server

# Only the built bundles of the two web apps. Their package.json files come too:
# npm workspaces symlinks point at these directories, and a dangling link is a
# confusing way to fail at startup.
COPY --from=build /app/apps/display/package.json ./apps/display/
COPY --from=build /app/apps/display/dist ./apps/display/dist
COPY --from=build /app/apps/controller/package.json ./apps/controller/
COPY --from=build /app/apps/controller/dist ./apps/controller/dist

USER node

EXPOSE 8787

# `/healthz` reports tick health as well as liveness — see the deploy notes in
# the README for what a rising `dropped` count means.
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
