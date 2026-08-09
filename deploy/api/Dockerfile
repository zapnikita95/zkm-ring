# Standalone zeleny-api — context = repo root (GitHub auto-deploy).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js ./
COPY server/lib ./lib/

ENV NODE_ENV=production
ENV ZM_DATA_DIR=/data
ENV PORT=8787
EXPOSE 8787

CMD ["node", "index.js"]
