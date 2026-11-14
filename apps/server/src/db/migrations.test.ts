import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

function insideGit(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('migraciones', () => {
  it('están numeradas 001, 002, 003… sin huecos ni repetidas', () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((f, i) => expect(f.startsWith(String(i + 1).padStart(3, '0') + '_'), `${f} debería ser la migración ${i + 1}`).toBe(true));
  });

  // Ya pasó una vez: el .gitignore (*.sql) dejó fuera migraciones nuevas y producción quedó sin sus columnas.
  it('ninguna está ignorada por git (si lo está, no llega al servidor)', () => {
    if (!insideGit()) return; // p. ej. dentro de la imagen de Docker
    for (const f of files) {
      let ignored = true;
      try {
        execFileSync('git', ['check-ignore', '--no-index', '-q', join(dir, f)], { cwd: dir, stdio: 'ignore' });
      } catch {
        ignored = false; // código 1 = no está ignorado
      }
      expect(ignored, `${f} está ignorada por .gitignore: no se subiría al repositorio`).toBe(false);
    }
  });
});
