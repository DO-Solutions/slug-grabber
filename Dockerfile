FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.js"] 