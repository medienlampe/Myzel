FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -r build && pnpm prune --prod

FROM node:22-alpine
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
ENV BUNDLE_ROOT=/bundle PORT=3800 HOST=0.0.0.0
EXPOSE 3800
VOLUME /bundle
CMD ["node", "packages/server/dist/index.js"]
