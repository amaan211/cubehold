# syntax=docker/dockerfile:1
#
# cubehold in one image, run as two containers (see compose.yaml): the agent,
# which runs the Minecraft servers, and the panel. Updating or restarting the
# panel never stops a server.
#
#   docker build -f docker/Dockerfile -t cubehold .

FROM node:24-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# build/app, with the native modules (argon2, libsql) for this image's platform.
RUN pnpm dist

FROM node:24-bookworm-slim
# CA certificates for tools that use the system store (tunnel clients).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/app /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=4000
VOLUME /data
EXPOSE 4000
ENTRYPOINT ["node", "/app/server.mjs"]
