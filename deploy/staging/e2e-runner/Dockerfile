# Staging e2e runner: Playwright + the repo's packages/e2e suite, run inside the private staging network.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /e2e
COPY package.json ./
RUN npm install --no-audit --no-fund --ignore-scripts @playwright/test@1.56.1 pg@8 typescript@5 @types/node@22 @types/pg@8
COPY playwright.config.ts tsconfig.json ./
COPY support ./support
COPY tests ./tests
COPY proxy.mjs ./
# Local ports mirror the browser-facing URLs baked into the staging images (localhost tunnel layout).
ENV E2E_BASE_URL=http://localhost:13000 E2E_API_URL=http://localhost:13001 CI=1
ENTRYPOINT ["node", "proxy.mjs"]
