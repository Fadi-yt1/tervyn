# Tervyn Remote Browser: real Chrome on a virtual display (Xvfb), streamed to the web page.
# Build from the repo root:  docker build -f browser/Dockerfile -t tervyn-browser .
#   docker run -p 8090:8090 -e ACCESS_KEY=choose-a-long-key -e PRIVATE_PROXIES="ip:port:user:pass ..." tervyn-browser
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8090 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY browser/package.json browser/package-lock.json ./browser/
RUN cd browser && npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb xauth fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
COPY gateway ./gateway
COPY platforms/node ./platforms/node
COPY browser ./browser
EXPOSE 8090
# Headed Chrome (a normal browser window) on a virtual screen.
CMD ["xvfb-run", "-a", "-s", "-screen 0 1920x1200x24", "node", "browser/server.mjs"]
