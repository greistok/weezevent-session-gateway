FROM ghcr.io/browserless/chromium:latest

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
