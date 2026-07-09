FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/storage/accounts.db

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./

RUN mkdir -p /app/storage && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["sh", "-c", "npm run seed && npm start"]
