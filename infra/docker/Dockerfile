# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
WORKDIR /app
ENV REDISMS_DISABLE_POSTINSTALL=true
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Keep pnpm's production symlink graph, but remove all development dependencies.
# Install scripts are intentionally disabled after the verified build.
FROM build AS production-deps
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-alpine AS runtime
ARG APP_VERSION=0.0.0
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown
ARG SOURCE_URL=https://github.com/AmazingZ-sys/financial-radar
LABEL org.opencontainers.image.title="Financial Radar" \
      org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$COMMIT_SHA \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source=$SOURCE_URL
ENV NODE_ENV=production APP_VERSION=$APP_VERSION COMMIT_SHA=$COMMIT_SHA
WORKDIR /app
# Copy only runtime artifacts; source, deployment config, fixtures on disk,
# browser bundles and build tooling are not part of the runtime filesystem.
COPY --from=production-deps --chown=node:node /app/package.json /app/package.json
COPY --from=production-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=production-deps --chown=node:node /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=production-deps --chown=node:node /app/apps/worker/node_modules /app/apps/worker/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist /app/apps/worker/dist
COPY --from=build --chown=node:node /app/packages/database/drizzle /app/packages/database/drizzle
USER node

FROM runtime AS api
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/index.js"]
