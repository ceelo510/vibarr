FROM node:22-alpine AS deps

USER root
WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

FROM node:22-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY --chown=node:node . .

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server.js"]
