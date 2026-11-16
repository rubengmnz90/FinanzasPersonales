-- Configuración del respaldo automático guardada desde la app. Una sola fila; el contenido va cifrado (AES-256-GCM)
-- con una llave que NO está en la base (SETTINGS_KEY o BACKUP_TOKEN del servidor).
CREATE TABLE IF NOT EXISTS backup_settings (
  id          int PRIMARY KEY CHECK (id = 1),
  config_enc  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
