FROM node:22-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src/ ./src/
COPY scripts/ ./scripts/

CMD ["node", "src/index.js"]
