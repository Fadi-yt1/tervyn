# Tervyn gateway for container hosts and free VMs.
#   docker build -t tervyn-gateway . && docker run -p 8080:8080 -e EXITS=1 tervyn-gateway
FROM node:22-alpine
WORKDIR /app
COPY package.json gateways.json ./
COPY gateway ./gateway
COPY platforms/node ./platforms/node
COPY scripts ./scripts
RUN node scripts/build-assets.mjs
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "platforms/node/server.mjs"]
