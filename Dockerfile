FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install --production

RUN npx playwright install chromium

COPY src/ ./src/

RUN mkdir -p /app/data /app/screenshots

ENV NODE_ENV=production

CMD ["node", "src/index.js", "scheduler"]
