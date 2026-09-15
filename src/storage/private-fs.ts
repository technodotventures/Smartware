import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type WriteFileOptions,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function chmodPortable(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  chmodSync(path, mode);
}

function normalizeEncoding(options: WriteFileOptions): BufferEncoding {
  if (options == null) return 'utf8';
  if (typeof options === 'string') return options;
  return options.encoding ?? 'utf8';
}

/**
 * fsync a directory entry so a rename survives power loss. Some filesystems
 * reject directory fsync; the file itself was fsynced before the rename, so
 * process-kill durability holds either way.
 */
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync unsupported — see comment above.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodPortable(path, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) return;
  chmodPortable(path, PRIVATE_FILE_MODE);
}

export function writePrivateFile(
  path: string,
  data: string,
  options: WriteFileOptions = 'utf8',
): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, data, {
    ...(typeof options === 'string' ? { encoding: options } : options),
    mode: PRIVATE_FILE_MODE,
  });
  ensurePrivateFile(path);
}

/**
 * Durable variant of `writePrivateFile`: write a private temp file, fsync it,
 * rename it over the destination, then fsync the directory. Readers (and a
 * crash) never observe a partial file, and a returned write is durable — the
 * same commit discipline as the intent writer (`src/ops_log/intent.ts`).
 *
 * Use this only where a torn/lost write corrupts state that cannot be
 * regenerated — `config.json` is provisioning state read by every operation,
 * and a lost config write after an ops entry (or vice versa) is a real
 * divergence the substrate must not create. Derived, regenerable artifacts
 * (wiki pages, exports, reports) stay on plain `writePrivateFile`, where
 * per-file fsync is a measured cost.
 */
export function writePrivateFileDurable(
  path: string,
  data: string,
  options: WriteFileOptions = 'utf8',
): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  // Hidden + unique so a concurrent writer cannot collide, and a crash
  // leaves an inert dotfile rather than a plausible-looking destination.
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', PRIVATE_FILE_MODE);
  try {
    writeFileSync(fd, data, normalizeEncoding(options));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // renameSync is atomic on the same filesystem; the destination keeps the
    // temp file's 0o600 mode.
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort: the destination was not replaced, the temp file is inert.
    }
    throw error;
  }
  syncDirectory(directory);
}
