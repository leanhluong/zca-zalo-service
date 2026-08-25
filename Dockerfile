# ── Build: biên dịch TypeScript → dist/ ──────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── Runtime: chỉ dependency production + dist ────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s CMD curl -sf http://127.0.0.1:3100/health || exit 1
CMD ["node", "dist/index.js"]
