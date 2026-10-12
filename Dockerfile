FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
# Build, then reinstall production dependencies only, from the store the first
# install already filled (--offline: no network). A fresh install rather than
# `pnpm prune --prod`, which leaves the workspace packages without their links.
RUN pnpm -r build \
  && rm -rf node_modules packages/*/node_modules \
  && pnpm install --prod --frozen-lockfile --offline

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
# tini: a real PID 1 that forwards SIGTERM to Node and reaps zombies, so
# `docker stop` triggers the graceful shutdown instead of a SIGKILL.
# git: needed for GIT_AUTOCOMMIT.
RUN apk add --no-cache tini git
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/node_modules packages/server/node_modules
COPY --from=build /app/packages/web/dist packages/web/dist

# Run unprivileged. The bundle directory is created and handed to the `node`
# user (uid 1000, present in the base image) BEFORE the VOLUME declaration, so
# a fresh named volume inherits that ownership. A bind-mounted host directory
# keeps its own ownership — make it writable by uid 1000 if you use one.
RUN mkdir -p /bundle && chown -R node:node /bundle
USER node

# A container must bind all interfaces for its published port to work; that is
# the deliberate public bind the server otherwise refuses to make on its own.
# Set AUTH_TOKEN when the port is reachable beyond the Docker host.
ENV NODE_ENV=production BUNDLE_ROOT=/bundle PORT=3800 HOST=0.0.0.0
# Identity for GIT_AUTOCOMMIT commits; override per deployment if you like.
ENV GIT_AUTHOR_NAME=understory GIT_AUTHOR_EMAIL=understory@localhost \
    GIT_COMMITTER_NAME=understory GIT_COMMITTER_EMAIL=understory@localhost
EXPOSE 3800
VOLUME /bundle
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3800)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
