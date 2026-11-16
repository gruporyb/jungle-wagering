FROM oven/bun:1
WORKDIR /app
# No npm dependencies: Bun ships the SQL driver and the HTTP server.
COPY src ./src
COPY public ./public
ENV NODE_ENV=production BACKOFFICE_PORT=4000
EXPOSE 4000
CMD ["bun", "src/main.ts"]
