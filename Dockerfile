# ── Etapa 1: instala dependencias y compila el front ──
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm -F web build

# ── Etapa 2: imagen final (corre como usuario sin privilegios) ──
FROM node:22-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/server
EXPOSE 3000

# Salud: la app responde y la base contesta.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migra (lo hace el servidor al arrancar), siembra el usuario inicial si SEED_USER_PASSWORD está definida
# (idempotente: no pisa la contraseña de un usuario existente) y arranca.
CMD ["sh", "-c", "if [ -n \"$SEED_USER_PASSWORD\" ]; then ./node_modules/.bin/tsx src/db/seed.ts; fi; exec ./node_modules/.bin/tsx src/index.ts"]
