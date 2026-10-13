FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
# Build, then let pnpm assemble a self-contained production copy of the server
# (its dist, package.json and only the production dependencies, @myzel/core
# included). Smaller than copying the workspace's node_modules, and it avoids
# `pnpm prune --prod`, which leaves workspace packages without their links.
RUN pnpm -r build \
  && pnpm --filter @myzel/server deploy --prod --legacy /deploy/server

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# tini: a real PID 1 that forwards SIGTERM to Node and reaps zombies, so
# `docker stop` triggers the graceful shutdown instead of a SIGKILL.
# git: needed for GIT_AUTOCOMMIT.
RUN apk add --no-cache tini git
WORKDIR /app
# The server finds the UI at ../../web/dist relative to its dist/index.js.
COPY --from=build /deploy/server server
COPY --from=build /app/packages/web/dist web/dist

# Run unprivileged. The bundle directory is created and handed to the `node`
# user (uid 1000, present in the base image) BEFORE the VOLUME declaration, so
# a fresh named volume inherits that ownership. A bind-mounted host directory
# keeps its own ownership — make it writable by uid 1000 if you use one.
RUN mkdir -p /bundle /profiles /config && chown -R node:node /bundle /profiles /config
USER node

# A container must bind all interfaces for its published port to work; that is
# the deliberate public bind the server otherwise refuses to make on its own.
# Set AUTH_TOKEN when the port is reachable beyond the Docker host.
ENV NODE_ENV=production BUNDLE_ROOT=/bundle PORT=3800 HOST=0.0.0.0
# Where the settings page (ADMIN_TOKEN) saves; keep /config on a volume.
ENV SETTINGS_FILE=/config/settings.json
# Identity for GIT_AUTOCOMMIT commits; override per deployment if you like.
ENV GIT_AUTHOR_NAME=myzel GIT_AUTHOR_EMAIL=myzel@localhost \
    GIT_COMMITTER_NAME=myzel GIT_COMMITTER_EMAIL=myzel@localhost
EXPOSE 3800
VOLUME /bundle /config
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3800)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
