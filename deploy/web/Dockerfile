# Site (nginx) + API (node) in one container for green-route.ru
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN python3 scripts/build_seo_pages.py && npm run build

FROM node:22-bookworm-slim AS api-deps
WORKDIR /api
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js ./
COPY server/lib ./lib/

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends nginx python3 python3-matplotlib \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default \
  && mkdir -p /data /usr/share/nginx/html

COPY --from=api-deps /api /api
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/web/start.sh /start.sh
RUN chmod +x /start.sh

ENV ZM_DATA_DIR=/data
ENV PORT=8787
ENV NODE_ENV=production
EXPOSE 8080
CMD ["/start.sh"]
