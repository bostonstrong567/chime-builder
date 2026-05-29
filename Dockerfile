FROM oven/bun:1-debian AS base

# System deps for node-canvas + sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libgif-dev librsvg2-dev \
    libjpeg-dev libpixman-1-dev \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --no-progress

COPY src ./src
COPY fonts ./fonts
COPY tsconfig.json ./

RUN mkdir -p data uploads results

ENV PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:${PORT}/health || exit 1

CMD ["bun", "src/server.ts"]
