FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       fontconfig \
       fonts-dejavu-core \
       fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*

# Install the locked SwissLaser Poppins font family.
RUN mkdir -p /usr/local/share/fonts/poppins \
    && curl -fsSL \
       "https://cdn.jsdelivr.net/gh/OpturaUK/SwissLaserMedia@main/fonts/Poppins-Light.ttf" \
       -o /usr/local/share/fonts/poppins/Poppins-Light.ttf \
    && curl -fsSL \
       "https://cdn.jsdelivr.net/gh/OpturaUK/SwissLaserMedia@main/fonts/Poppins-LightItalic.ttf" \
       -o /usr/local/share/fonts/poppins/Poppins-LightItalic.ttf \
    && curl -fsSL \
       "https://cdn.jsdelivr.net/gh/OpturaUK/SwissLaserMedia@main/fonts/Poppins-Regular.ttf" \
       -o /usr/local/share/fonts/poppins/Poppins-Regular.ttf \
    && curl -fsSL \
       "https://cdn.jsdelivr.net/gh/OpturaUK/SwissLaserMedia@main/fonts/Poppins-SemiBold.ttf" \
       -o /usr/local/share/fonts/poppins/Poppins-SemiBold.ttf \
    && fc-cache -f

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["npm", "start"]
