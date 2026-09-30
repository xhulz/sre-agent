/**
 * Small JSON files on disk: the fake world, the agent's memory, and the kill switch.
 *
 * @remarks
 * Writes are atomic (temp file, then rename in the same directory), so a reader never sees half a
 * file. Two writers at the same time can still lose an update: acceptable for a one-responder
 * demo; production would use a database.
 *
 * @packageDocumentation
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Reads and parses a JSON file.
 *
 * @param path - The file.
 * @param ifMissing - Returned when the file does not exist.
 * @throws If the file exists but can't be read or parsed.
 */
export function readJsonFile<T>(path: string, ifMissing: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    if (isMissingFile(err)) return ifMissing;
    throw err;
  }
}

/**
 * Writes a JSON file atomically, creating its directory if needed.
 *
 * @param path - The file.
 * @param value - Anything JSON can hold.
 */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/**
 * Path of a tenant's file in a directory. The tenant id is validated so it can never escape the
 * directory (no `../`).
 *
 * @param dir - The directory.
 * @param tenantId - The tenant.
 */
export function tenantFile(dir: string, tenantId: string): string {
  if (!/^[a-z0-9-]+$/.test(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`);
  return join(dir, `${tenantId}.json`);
}

/**
 * Whether an error means "the file does not exist".
 *
 * @param err - What was thrown.
 */
function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}
