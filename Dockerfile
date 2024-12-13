FROM node:23.3-bookworm-slim

# Install app dependencies
# RUN apt update && apk add bash
COPY package.json /src/package.json

COPY . /src
WORKDIR /src
RUN npm install
RUN chown -R node:node /src

# change user
USER node

ENTRYPOINT ["/bin/bash", "-c"]
