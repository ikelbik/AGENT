FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY index.js migrate.js schema.sql ./
COPY bot/ ./bot/
COPY queue/ ./queue/
COPY agent/ ./agent/
COPY db/ ./db/

CMD ["node", "index.js"]
