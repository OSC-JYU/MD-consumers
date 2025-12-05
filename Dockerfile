FROM node:24.9.0-bookworm-slim

# Install app dependencies
# RUN apt update && apk add bash
COPY package.json /src/package.json

COPY --chown=node:node . /src
RUN mkdir -p /src/data && chown -R node:node /src/data
WORKDIR /src
RUN npm install


# change user
USER node

ENTRYPOINT ["/bin/bash", "-c"]
