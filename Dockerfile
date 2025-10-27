# syntax=docker/dockerfile:1.6

FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json svelte.config.js vite.config.ts ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY . .
RUN bun --bunx vite build

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
	PORT=4173

COPY --from=build /app/package.json ./package.json
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/bunfig.toml ./bunfig.toml
COPY --from=build /app/vite.config.ts ./vite.config.ts
COPY --from=build /app/svelte.config.js ./svelte.config.js
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/.svelte-kit ./.svelte-kit
COPY --from=build /app/build ./build
COPY --from=build /app/static ./static

EXPOSE 4173
CMD ["bun", "--bunx", "vite", "preview", "--host", "0.0.0.0", "--port", "4173"]
