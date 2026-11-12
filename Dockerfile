# VeriFact hosted service — Node 20, no build deps beyond tsc at build time
FROM node:20-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY benchmark ./benchmark
RUN npm run build

FROM node:20-slim
# Docker-in-docker for sandbox mode requires the host socket; on Fly we run
# the runner in local mode inside the same container (firecracker v1: fly
# machines provide the isolation boundary).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
ENV VERIFACT_PORT=8080
EXPOSE 8080
# Ledger persists on a mounted volume at /data
ENV VERIFACT_LEDGER_PATH=/data/ledger.json
VOLUME ["/data"]
CMD ["node", "dist/src/gh/webhook.js"]
