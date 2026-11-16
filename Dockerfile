# Runs the stdio bridge, for MCP catalogs and container-based clients. SharpTrader is not in the image: without it the
# bridge lists SharpTrader's tools and answers that it is not connected; with SHARPTRADER_URL and SHARPTRADER_TOKEN it
# forwards every message to SharpTrader's MCP server.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
USER node
ENTRYPOINT ["node", "server/index.js"]
