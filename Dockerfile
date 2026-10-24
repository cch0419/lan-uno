FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM dependencies AS test
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node tests ./tests
USER node
CMD ["npm", "test"]

FROM dependencies AS runtime
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "server/index.js", "--no-open"]
