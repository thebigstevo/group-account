# Stage 1: Install dependencies
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Production image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Create uploads directory writable by node user
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 3000

CMD ["node", "src/server.js"]
