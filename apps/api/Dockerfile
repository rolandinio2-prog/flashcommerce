ARG NODE_IMAGE
FROM $NODE_IMAGE AS base
RUN test "$(node --version)" = "v24.19.0" && npm install --global pnpm@11.21.0 --ignore-scripts --no-audit --no-fund
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts
FROM dependencies AS build
COPY . .
RUN pnpm run build && test -f dist/main.js
FROM base AS production_dependencies
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
FROM $NODE_IMAGE AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=production_dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
CMD ["node","dist/main.js"]
