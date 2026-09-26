FROM node:20-slim AS base
WORKDIR /repo
COPY package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json

FROM base AS deps
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
WORKDIR /repo/packages/shared
RUN npm run build
WORKDIR /repo/apps/api
RUN npx prisma generate
RUN npm run build

# Runtime image mirrors the /repo layout from the build stage (rather than
# flattening into /app) because node_modules/@media-platform/shared is an
# npm-workspaces symlink to ../../packages/shared — flattening into /app
# would break that symlink's relative target.
FROM node:20-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/shared/dist /repo/packages/shared/dist
COPY --from=build /repo/packages/shared/package.json /repo/packages/shared/package.json
COPY --from=build /repo/apps/api/dist /repo/apps/api/dist
COPY --from=build /repo/apps/api/prisma /repo/apps/api/prisma
COPY --from=build /repo/apps/api/package.json /repo/apps/api/package.json

WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
