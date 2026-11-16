import {
  DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ServerSideEncryption,
} from '@aws-sdk/client-s3';

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

/** Dónde se guardan las copias. Lo mínimo que necesita el respaldo automático. */
export interface BackupStore {
  put(key: string, body: Buffer): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

export interface S3Config {
  /** p. ej. https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  region: string;
  keyId: string;
  secret: string;
  bucket: string;
  /** Cifrado en reposo del lado del proveedor (SSE-B2 = AES256). 'none' para no pedirlo. */
  sse?: 'AES256' | 'none';
}

/** Cualquier almacenamiento compatible con S3: Backblaze B2, Cloudflare R2, Wasabi, MinIO… */
export class S3Store implements BackupStore {
  private client: S3Client;

  constructor(private cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
      forcePathStyle: true,
      // Backblaze y otros no aceptan los checksums automáticos nuevos del SDK: solo se envían cuando son obligatorios.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 4,
    });
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: 'application/zip', ContentLength: body.length,
      ...(this.cfg.sse === 'none' ? {} : { ServerSideEncryption: (this.cfg.sse ?? 'AES256') as ServerSideEncryption }),
    }));
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0), lastModified: o.LastModified ?? new Date(0) });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

/** Almacenamiento en memoria, para pruebas. */
export class MemoryStore implements BackupStore {
  objects = new Map<string, { body: Buffer; lastModified: Date }>();
  failPut = false;

  async put(key: string, body: Buffer): Promise<void> {
    if (this.failPut) throw new Error('almacenamiento no disponible');
    this.objects.set(key, { body, lastModified: new Date() });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.body.length, lastModified: o.lastModified }));
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
