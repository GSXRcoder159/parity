# The twin: no dependencies to install, Node runs the TypeScript directly (type stripping, Node >= 22.18).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 12111
# Exec form: node is PID 1 and receives SIGTERM from `docker stop`.
CMD ["node", "src/twin/main.ts", "--host", "0.0.0.0"]
