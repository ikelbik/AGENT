FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY index.js ./
COPY bot/ ./bot/
COPY queue/ ./queue/
COPY agent/ ./agent/
COPY db/ ./db/
COPY server/ ./server/

CMD ["node", "index.js"]
