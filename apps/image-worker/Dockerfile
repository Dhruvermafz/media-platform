FROM node:20-slim AS base
WORKDIR /repo
COPY package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/image-worker/package.json apps/image-worker/package.json

FROM base AS deps
# sharp needs build tools for its prebuilt-binary postinstall on some platforms
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/image-worker apps/image-worker
WORKDIR /repo/packages/shared
RUN npm run build
WORKDIR /repo/apps/image-worker
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/shared/dist /repo/packages/shared/dist
COPY --from=build /repo/packages/shared/package.json /repo/packages/shared/package.json
COPY --from=build /repo/apps/image-worker/dist /repo/apps/image-worker/dist
COPY --from=build /repo/apps/image-worker/package.json /repo/apps/image-worker/package.json

WORKDIR /repo/apps/image-worker
EXPOSE 9100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9100/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
