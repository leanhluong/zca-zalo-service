FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s CMD curl -sf http://127.0.0.1:3100/health || exit 1
CMD ["node", "src/index.js"]
