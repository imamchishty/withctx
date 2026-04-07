FROM node:20-alpine

# Install Claude CLI
RUN npm i -g @anthropic-ai/claude-code

# Install withctx
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/

# Volume for project data
VOLUME ["/data"]
WORKDIR /data

EXPOSE 4400

# Default: serve mode
CMD ["node", "/app/dist/cli/index.js", "serve"]
