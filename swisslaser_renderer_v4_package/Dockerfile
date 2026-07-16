FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["npm", "start"]
