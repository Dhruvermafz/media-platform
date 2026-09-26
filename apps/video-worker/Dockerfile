FROM node:20-slim AS base
WORKDIR /repo
COPY package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/video-worker/package.json apps/video-worker/package.json

FROM base AS deps
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/video-worker apps/video-worker
WORKDIR /repo/packages/shared
RUN npm run build
WORKDIR /repo/apps/video-worker
RUN npm run build

FROM node:20-slim AS runtime
# fluent-ffmpeg shells out to the system ffmpeg binary — it is not bundled
# by the npm package, so it must be present in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/shared/dist /repo/packages/shared/dist
COPY --from=build /repo/packages/shared/package.json /repo/packages/shared/package.json
COPY --from=build /repo/apps/video-worker/dist /repo/apps/video-worker/dist
COPY --from=build /repo/apps/video-worker/package.json /repo/apps/video-worker/package.json

WORKDIR /repo/apps/video-worker
EXPOSE 9100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9100/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
