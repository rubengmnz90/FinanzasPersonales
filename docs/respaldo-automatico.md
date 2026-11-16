# Respaldo automático en la nube (Backblaze B2)

La app sube **4 copias completas al día** (`.zip` de `pg_dump`) a un bucket privado y borra las viejas con el método **GFS**.
Funciona con Backblaze B2 y con cualquier almacenamiento compatible con S3 (Cloudflare R2, Wasabi, MinIO…).
Mientras no definas las variables de abajo, queda **apagado** y no cambia nada.

## Qué se conserva (GFS)

Cada copia se llama `finanzas-AAAAMMDD-HHMMSS.zip` (hora UTC). Con las 4 copias diarias, la política por defecto deja:

| Rol | Qué se guarda | Por defecto |
|---|---|---|
| Reciente | **todas** las copias de los últimos N días | 2 días (≈ 8 copias) |
| Diaria | la **última de cada día** | 7 días |
| Semanal | **una por semana** (la última, de lunes a domingo) | 4 semanas |
| Mensual | **una por mes** (la última) | 12 meses |

Una misma copia puede cumplir varios roles. En régimen quedan unas 20–30 copias; cada una pesa pocos cientos de KB, así que
cabe de sobra en los 10 GB gratis de Backblaze. La copia más nueva nunca se borra, y solo se borra después de comprobar que
la nueva quedó subida con el tamaño correcto. Los archivos que no se llamen como las copias no se tocan jamás.

## Configurar Backblaze (una sola vez)

1. Crea la cuenta en <https://www.backblaze.com> y entra a **B2 Cloud Storage**.
2. **Buckets → Create a Bucket**
   - Nombre único (p. ej. `finanzas-rubengmnz-respaldos`).
   - **Files in Bucket are: Private** (¡importante! cada copia trae todos los usuarios y hashes de contraseña).
   - **Default Encryption: Enable** (cifrado en reposo).
   - Object Lock: desactivado.
3. En el bucket → **Lifecycle Settings → Keep only the last version of the file**.
   Backblaze conserva por defecto las versiones "borradas" y seguirías pagando ese espacio; con esta regla el borrado de GFS libera espacio de verdad.
4. **Application Keys → Add a New Application Key**
   - Nombre: `finanzas-respaldo`.
   - **Allow access to Bucket(s):** solo ese bucket (no uses la Master Key).
   - **Type of Access: Read and Write.**
   - Copia el **keyID** y la **applicationKey** (la clave se muestra una sola vez).
5. En la lista de buckets copia el **Endpoint** del bucket, p. ej. `s3.us-west-004.backblazeb2.com`.

## Conectarlo al servidor

En el `.env` del servidor (`~/finanzas/.env`, nunca se sube a git) agrega:

```env
BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
BACKUP_S3_KEY_ID=<keyID>
BACKUP_S3_SECRET=<applicationKey>
BACKUP_S3_BUCKET=finanzas-rubengmnz-respaldos
```

y recrea la app para que lea el `.env`:

```bash
cd ~/finanzas && docker compose --profile https up -d
```

Entra a **Respaldo** en la app: la sección *Respaldo automático en la nube* debe decir que está activo. Pulsa
**Respaldar ahora** para probar; tiene que aparecer la primera copia en la tabla y en tu bucket de Backblaze.

## Opciones (todas opcionales)

| Variable | Por defecto | Para qué |
|---|---|---|
| `BACKUP_HOURS` | `0,6,12,18` | Horas del día (en `BACKUP_TZ`) en que se hace una copia |
| `BACKUP_TZ` | `America/Asuncion` | Zona horaria de las horas y de lo que cuenta como "día", "semana" y "mes" |
| `BACKUP_KEEP_RECENT_DAYS` | `2` | Días en que se guardan **todas** las copias |
| `BACKUP_KEEP_DAILY` | `7` | Días con su última copia |
| `BACKUP_KEEP_WEEKLY` | `4` | Semanas con una copia |
| `BACKUP_KEEP_MONTHLY` | `12` | Meses con una copia |
| `BACKUP_S3_PREFIX` | `finanzas/` | Carpeta dentro del bucket |
| `BACKUP_S3_REGION` | sale del endpoint | Región, si tu proveedor la pide aparte |
| `BACKUP_S3_SSE` | `AES256` | Cifrado del lado del proveedor; `none` si tu S3 no lo acepta |
| `BACKUP_AUTO` | activo | `false` para apagarlo sin quitar las claves |

## Cómo funciona

- Cada 5 minutos la app mira si ya pasó una hora programada sin copia y, si es así, la hace. Si el servidor estaba apagado o
  se estaba desplegando, la copia se hace apenas vuelve (no se duplican: antes mira qué hay en el bucket).
- Si falla (sin internet, clave mal puesta…) lo muestra en la pantalla de Respaldo y en los logs
  (`docker compose logs app | grep respaldo-auto`) y reintenta a los 30 minutos.
- Antes de subir comprueba que el dump sea restaurable, y después comprueba que el archivo quedó con el tamaño correcto.

## Recuperar una copia

1. Baja el `.zip` que quieras desde la web de Backblaze (o con `b2 download-file-by-name`).
2. En la app: **Respaldo → Restaurar desde un respaldo (ZIP)**. Reemplaza toda la base (pide confirmación).
