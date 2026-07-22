FROM oven/bun:1.3.3 AS build

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && \
	bun build packages/server/containers/portable-materializer/server.ts \
		--target=bun \
		--outfile=/build/server.js

FROM oven/bun:1.3.3

WORKDIR /app
COPY --from=build --chown=bun:bun /build/server.js ./server.js
USER bun
CMD ["bun", "run", "server.js"]
