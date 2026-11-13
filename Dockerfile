FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -F web build

FROM node:22-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
WORKDIR /app/apps/server
# Migra, siembra el usuario inicial (si SEED_* está definido; idempotente) y arranca.
CMD ["sh", "-c", "if [ -n \"$SEED_USER_PASSWORD\" ]; then pnpm seed; fi; exec pnpm start"]
