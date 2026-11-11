FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx tsx scripts/verify-fixtures.ts && mkdir -p out && chown -R node:node /app/out
USER node
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
