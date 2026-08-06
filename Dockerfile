FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
RUN apk add --no-cache python3 py3-pip ffmpeg ca-certificates chromium nss freetype harfbuzz ttf-freefont \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default,curl-cffi]' \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && addgroup -S onepick \
  && adduser -S -G onepick -h /app onepick
COPY --from=deps --chown=onepick:onepick /app/node_modules ./node_modules
COPY --chown=onepick:onepick package*.json ./
COPY --chown=onepick:onepick src ./src
COPY --chown=onepick:onepick public ./public
COPY --chown=onepick:onepick scripts ./scripts
USER onepick
EXPOSE 3000
# Run Node directly so Docker delivers SIGTERM to the application, not an npm wrapper.
# This avoids npm reporting an expected supervisor stop as "npm error".
CMD ["node", "src/server.js"]
