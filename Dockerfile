FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY public ./public
COPY server.js ./

EXPOSE 4545

CMD ["node", "server.js"]
