#!/usr/bin/env bash
# Despliega Finanzas Personales en un servidor Linux con Docker + Traefik.
#
# Uso (dentro de una carpeta del servidor, p. ej. ~/projects/finanzas):
#   ./deploy.sh                    configura y despliega (o actualiza si ya existe)
#   ./deploy.sh status             estado de los contenedores
#   ./deploy.sh logs [servicio]    logs en vivo (finanzas_app | finanzas_db)
#   ./deploy.sh backup             respaldo de la base en ./backups (conserva los últimos 14)
#   ./deploy.sh import-excel FILE  importa "Administracion 2026.xlsx" a la base
#   ./deploy.sh help
#
# Variables opcionales: REPO_URL, BRANCH, GITHUB_TOKEN (repo privado por HTTPS),
# DOMAIN_URL, SEED_EMAIL, SEED_USER_PASSWORD, ASSUME_YES=1 (sin preguntas).

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/rubengmnz90/FinanzasPersonales.git}"
BRANCH="${BRANCH:-main}"
APP_DIR_NAME="${APP_DIR_NAME:-finanzas-app}"
COMPOSE_FILE="docker-compose.traefik.yml"
PROJECT="finanzas"
APP_CONTAINER="finanzas_production_app"
DB_CONTAINER="finanzas_production_db"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '%s!!%s  %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=""

# git con token opcional (no queda guardado en .git/config).
git_auth() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    local h; h="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $h" "$@"
  else
    git "$@"
  fi
}

dc() { docker compose -p "$PROJECT" -f "$ROOT/$COMPOSE_FILE" --project-directory "$ROOT" "$@"; }

need() { command -v "$1" >/dev/null 2>&1 || die "Falta '$1'. Instálalo y vuelve a correr el script."; }

preflight() {
  need docker; need git; need openssl; need curl
  docker compose version >/dev/null 2>&1 || die "Falta el plugin 'docker compose' (Docker Compose v2)."
  docker info >/dev/null 2>&1 || die "No puedo usar Docker. ¿Tu usuario está en el grupo 'docker'? (sudo usermod -aG docker \$USER y vuelve a entrar)"
}

# Ubica el código: junto al script (si está dentro del repo) o lo clona en ./finanzas-app.
locate_repo() {
  if [ -f "$HERE/$COMPOSE_FILE" ]; then
    ROOT="$HERE"
  else
    ROOT="$PWD/$APP_DIR_NAME"
  fi
}

sync_code() {
  if [ ! -d "$ROOT/.git" ]; then
    log "Clonando $REPO_URL ($BRANCH) en $ROOT"
    git_auth clone --branch "$BRANCH" "$REPO_URL" "$ROOT" \
      || die "No pude clonar. Si el repo es privado: exporta GITHUB_TOKEN=<token con permiso de lectura> o usa REPO_URL=git@github.com:rubengmnz90/FinanzasPersonales.git con una deploy key."
  else
    log "Actualizando código ($BRANCH)"
    git_auth -C "$ROOT" fetch origin "$BRANCH" || die "No pude hacer fetch (¿credenciales?)."
    git -C "$ROOT" checkout "$BRANCH" >/dev/null 2>&1 || true
    git -C "$ROOT" merge --ff-only "origin/$BRANCH" || die "Hay cambios locales que impiden actualizar. Revisa 'git -C $ROOT status'."
  fi
  [ -f "$ROOT/$COMPOSE_FILE" ] || die "No encuentro $COMPOSE_FILE en $ROOT."
}

# Lee un valor: variable de entorno > pregunta (si hay terminal) > valor por defecto.
ask() { # nombre, texto, defecto
  local name="$1" text="$2" def="$3" cur="${!1:-}"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return; fi
  if [ -t 0 ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    local v; read -r -p "$text [$def]: " v </dev/tty || true
    printf '%s' "${v:-$def}"
  else
    printf '%s' "$def"
  fi
}

ensure_env() {
  local f="$ROOT/.env"
  if [ -f "$f" ]; then
    log ".env existente: se conserva (no se pisa)"
    if ! grep -q '^BACKUP_TOKEN=' "$f"; then
      printf '
BACKUP_TOKEN=%s
' "$(openssl rand -hex 32)" >> "$f"
      log "Se agregó BACKUP_TOKEN a .env (para el respaldo completo por API; léelo con: grep BACKUP_TOKEN .env)"
    fi
  else
    log "Creando .env (permisos 600)"
    local domain email seedpw dbpw
    domain="$(ask DOMAIN_URL 'Dominio de la app' 'finanzas.vibralejana.com')"
    email="$(ask SEED_EMAIL 'Correo del usuario inicial' 'rubengmnz90@gmail.com')"
    seedpw="${SEED_USER_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-16)}"
    dbpw="$(openssl rand -hex 24)"
    umask 077
    cat > "$f" <<EOF
# Generado por deploy.sh. No lo subas a git.
DOMAIN_URL=$domain
PUBLIC_URL=https://$domain
POSTGRES_PASSWORD=$dbpw
SEED_EMAIL=$email
SEED_USER_PASSWORD=$seedpw
ALLOW_SIGNUP=false

# Traefik (ajusta si tu instalación usa otros nombres)
TRAEFIK_NETWORK=proxy
TRAEFIK_ENTRYPOINT_HTTP=http
TRAEFIK_ENTRYPOINT_HTTPS=https
TRAEFIK_CERTRESOLVER=production
EOF
    printf 'BACKUP_TOKEN=%s
' "$(openssl rand -hex 32)" >> "$f"
    chmod 600 "$f"
    NEW_ENV=1
    GENERATED_SEED_PW="$seedpw"
  fi
  # shellcheck disable=SC1090
  set -a; . "$f"; set +a
}

check_traefik_network() {
  local net="${TRAEFIK_NETWORK:-proxy}"
  docker network inspect "$net" >/dev/null 2>&1 \
    || die "No existe la red de Traefik '$net'. Créala/ajústala (TRAEFIK_NETWORK en $ROOT/.env). Redes: $(docker network ls --format '{{.Name}}' | tr '\n' ' ')"
}

check_dns() {
  local ip_dns ip_srv
  ip_dns="$(getent hosts "$DOMAIN_URL" 2>/dev/null | awk '{print $1; exit}' || true)"
  ip_srv="$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
  if [ -z "$ip_dns" ]; then
    warn "$DOMAIN_URL aún no resuelve por DNS. Crea el registro A en Namecheap hacia ${ip_srv:-la IP de este servidor}; hasta entonces Traefik no podrá emitir el certificado."
  elif [ -n "$ip_srv" ] && [ "$ip_dns" != "$ip_srv" ]; then
    warn "$DOMAIN_URL resuelve a $ip_dns pero este servidor sale por $ip_srv (revisa el registro A o si hay proxy delante)."
  else
    log "DNS ok: $DOMAIN_URL -> $ip_dns"
  fi
}

wait_healthy() {
  log "Esperando a que la app esté sana (hasta 3 min)…"
  local i st
  for i in $(seq 1 36); do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$APP_CONTAINER" 2>/dev/null || echo missing)"
    case "$st" in
      healthy|running) [ "$st" = "healthy" ] && { log "App sana"; return 0; } ;;
      exited|dead) break ;;
    esac
    sleep 5
  done
  warn "La app no quedó sana (estado: $st). Últimos logs:"
  dc logs --tail 40 finanzas_app >&2 || true
  die "Despliegue incompleto."
}

check_public() {
  local url="https://$DOMAIN_URL/healthz" i
  log "Probando $url (el certificado puede tardar 1-2 min en emitirse)…"
  for i in 1 2 3 4 5 6; do
    if curl -fsS --max-time 8 "$url" >/dev/null 2>&1; then log "Responde por HTTPS"; return 0; fi
    sleep 10
  done
  warn "Aún no responde por HTTPS. Revisa DNS y los logs de Traefik ('docker logs <traefik> | tail'). La app sí está corriendo."
}

cmd_deploy() {
  preflight; locate_repo; sync_code; ensure_env; check_traefik_network; check_dns
  log "Construyendo y levantando contenedores"
  dc up -d --build --remove-orphans
  wait_healthy
  check_public
  echo
  log "Listo: https://$DOMAIN_URL"
  if [ "${NEW_ENV:-0}" = "1" ]; then
    echo
    echo "  Usuario inicial : $SEED_EMAIL"
    echo "  Clave inicial   : $GENERATED_SEED_PW   (la app te pedirá cambiarla en el primer ingreso)"
    echo "  Guárdala ahora: después de cambiarla puedes borrar SEED_USER_PASSWORD de $ROOT/.env"
  fi
  echo
  echo "  Respaldo: desde la app, menú Respaldo > Descargar respaldo."
  echo "  Conectar la IA (MCP): https://$DOMAIN_URL/mcp"
}

cmd_status() { preflight; locate_repo; ensure_env; dc ps; }
cmd_logs()   { preflight; locate_repo; ensure_env; dc logs -f --tail 100 "${1:-finanzas_app}"; }

cmd_backup() {
  preflight; locate_repo; ensure_env
  mkdir -p "$ROOT/backups"; umask 077
  local out="$ROOT/backups/finanzas-$(date +%Y%m%d-%H%M%S).sql.gz"
  docker exec "$DB_CONTAINER" pg_dump -U postgres finanzas | gzip > "$out"
  [ -s "$out" ] || { rm -f "$out"; die "El respaldo salió vacío."; }
  ls -1t "$ROOT"/backups/finanzas-*.sql.gz | tail -n +15 | xargs -r rm -f
  log "Respaldo: $out"
}

cmd_import() {
  local file="${1:-}"; [ -n "$file" ] && [ -f "$file" ] || die "Uso: ./deploy.sh import-excel /ruta/Administracion\\ 2026.xlsx"
  preflight; locate_repo; ensure_env
  docker cp "$file" "$APP_CONTAINER:/tmp/admin.xlsx"
  docker exec "$APP_CONTAINER" ./node_modules/.bin/tsx src/import/cli.ts --file /tmp/admin.xlsx
  docker exec "$APP_CONTAINER" rm -f /tmp/admin.xlsx
  log "Importación terminada"
}

main() {
  case "${1:-deploy}" in
    deploy|update|up) cmd_deploy ;;
    status)  cmd_status ;;
    logs)    shift; cmd_logs "${1:-}" ;;
    backup)  cmd_backup ;;
    import-excel) shift; cmd_import "${1:-}" ;;
    help|-h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
    *) die "Comando desconocido: $1 (usa ./deploy.sh help)" ;;
  esac
}

main "$@"
exit $?
