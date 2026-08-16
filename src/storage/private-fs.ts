import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  type WriteFileOptions,
} from 'node:fs';
import { dirname } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function chmodPortable(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  chmodSync(path, mode);
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
