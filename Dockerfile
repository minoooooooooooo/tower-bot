# syntax=docker/dockerfile:1

# Node 24 LTS. Multi-arch, so it runs on both Oracle's Ampere ARM and AMD shapes.
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first so this layer is cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# SQLite lives here. Created in the image so the unprivileged user can write
# to it when a volume is mounted over this path.
RUN mkdir -p /app/data && chown node:node /app/data

# The official image ships an unprivileged "node" user.
USER node

# The bot only makes outbound connections, so no port is exposed.
CMD ["node", "src/boot.js"]
