# 台灣通 MaaS 伺服器（零依賴：只需要 Node）
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data CACHE_DIR=/tmp/taiwantong-cache
COPY package.json build.mjs ./
COPY index.html sw.js manifest.webmanifest ./
COPY css ./css
COPY js ./js
COPY icons ./icons
COPY server ./server
COPY data/metro.json /data/metro.json
RUN node build.mjs && addgroup -S app && adduser -S app -G app && chown -R app:app /app /data
USER app
EXPOSE 8080
# 路網資料用 volume 掛進 /data（/data/graph/nodes.json…）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:8080/api/v1/health >/dev/null || exit 1
CMD ["node", "server/server.mjs"]
