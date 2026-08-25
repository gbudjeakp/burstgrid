FROM node:24-slim AS base
RUN npm install -g pnpm@9 --quiet
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN COREPACK_ENABLE_STRICT=0 pnpm install --frozen-lockfile
COPY . .

FROM base AS scheduler
EXPOSE 8080
CMD ["node", "--import", "tsx/esm", "bin/scheduler.ts"]

FROM base AS worker
CMD ["node", "--import", "tsx/esm", "bin/worker-agent.ts"]
