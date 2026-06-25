FROM node:24-alpine

WORKDIR /app
COPY . .

ENV NODE_ENV=production
# Hyperlift routes to 8080 by default; the app reads process.env.PORT
ENV PORT=8080
EXPOSE 8080

# zero dependencies — nothing to npm install
CMD ["node", "server.js"]
