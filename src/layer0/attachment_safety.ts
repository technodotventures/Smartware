// Attachment safety — file-type allowlist and size limits for ingestion.
//
// Only text-extractable file types are allowed. Executables, archives,
// and binary formats are rejected. Content is text-only extraction —
// files are never executed or rendered.

const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.rtf', '.odt', '.ods', '.odp',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
  '.log', '.ini', '.cfg', '.conf',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.cs',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.proto',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.scr', '.pif',
  '.app', '.dmg', '.pkg', '.deb', '.rpm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.iso', '.img', '.vmdk', '.vdi',
  '.jar', '.war', '.class',
  '.wasm', '.bin', '.dat',
]);

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface AttachmentCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkAttachmentSafety(
  filename: string,
  sizeBytes: number,
): AttachmentCheckResult {
  if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      allowed: false,
      reason: `File exceeds ${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB limit (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
    };
  }

  const ext = filename.includes('.') ? '.' + filename.split('.').pop()!.toLowerCase() : '';

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return {
      allowed: false,
      reason: `Blocked file type: ${ext}. Executables and archives are not ingested.`,
    };
  }

  if (!ext || ALLOWED_EXTENSIONS.has(ext)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Unknown file type: ${ext}. Only text-extractable file types are allowed.`,
  };
}

export function isTextExtractable(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json') return true;
  if (mimeType === 'application/pdf') return true;
  if (mimeType.includes('openxmlformats') || mimeType.includes('opendocument')) return true;
  if (mimeType === 'application/rtf') return true;
  return false;
}
