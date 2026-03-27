FROM node:24.9.0-bookworm-slim

# Install app dependencies
#RUN apt update && apt install -y bash python3 make g++
COPY package.json /src/package.json
COPY package-lock.json /src/package-lock.json

COPY --chown=node:node . /src
RUN mkdir -p /src/data && chown -R node:node /src/data
WORKDIR /src
RUN npm ci
RUN npm cache clean --force


# change user
USER node

ENTRYPOINT ["/bin/bash", "-c"]
