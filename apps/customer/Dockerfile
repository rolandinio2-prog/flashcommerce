# syntax=docker/dockerfile:1
ARG NODE_IMAGE
FROM $NODE_IMAGE AS base
RUN test "$(node --version)" = "v24.19.0" && npm install --global pnpm@11.21.0 --ignore-scripts --no-audit --no-fund
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts
FROM dependencies AS build
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY . .
RUN --mount=type=secret,id=public_env,required=true node build-next.cjs
FROM $NODE_IMAGE AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
CMD ["node","server.js"]
