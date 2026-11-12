FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY lib ./lib
COPY bin ./bin
COPY docs/openapi.json ./docs/openapi.json
COPY assets ./assets
RUN mkdir -p /data && chown node:node /data
USER node
ENV OBU_API_HOST=0.0.0.0 OBU_API_PORT=4319 OBU_DATA_DIR=/data BROWSER_HEADLESS=1 BROWSER_CHANNEL=chromium
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:4319/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/server.js"]
