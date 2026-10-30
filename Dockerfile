# The services process, `pnpm serve`: the indexer, the API and the keeper of one deployment, in one
# container. It reads its settings from the environment (see .env.example): no env file goes into
# the image. Run one container per database. Where it is hosted is the owner's choice (spike S9).
FROM node:24.21.0-slim

RUN corepack enable && corepack prepare pnpm@10.26.0 --activate

WORKDIR /app
COPY . .
# The root and every workspace package it depends on, which is all of them but the web app: that is
# deployed on its own. deployments/ stays in the image, since the indexer reads it.
RUN pnpm install --frozen-lockfile --filter "tender..."

EXPOSE 8787
CMD ["pnpm", "serve"]
