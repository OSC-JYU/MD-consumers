FROM node:24.9.0-bookworm-slim AS deps

WORKDIR /src

ENV NODE_ENV=production

ARG WITH_SHARP=true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
	&& if [ "$WITH_SHARP" = "false" ]; then npm uninstall sharp --no-audit --no-fund; fi \
	&& npm cache clean --force

FROM node:24.9.0-bookworm-slim

WORKDIR /src

ENV NODE_ENV=production

COPY --from=deps /src/node_modules ./node_modules

COPY --chown=node:node src ./src
COPY --chown=node:node README.md ./README.md


# change user
USER node

CMD ["node", "src/index.mjs"]
