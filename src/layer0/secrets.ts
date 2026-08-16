// Layer 0 — Secret Pattern Detection
// Safety net against storing credentials in the evidence log

export interface SecretDetectionResult {
  detected: boolean;
  type?: string;
  location?: string;
  snippet?: string;
}

const PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret_key', pattern: /[Aa][Ww][Ss]_?[Ss][Ee][Cc][Rr][Ee][Tt]_?[Kk][Ee][Yy]\s*[:=]\s*[A-Za-z0-9/+]{40}/g },
  { name: 'github_token', pattern: /ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}/g },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9]{32,}/g },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{32,}/g },
  { name: 'stripe_key', pattern: /sk_live_[A-Za-z0-9]{24,}|pk_live_[A-Za-z0-9]{24,}/g },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/g },
  { name: 'password_in_url', pattern: /(?:https?:\/\/)[^:@\s]+:[^@\s]+@/g },
  { name: 'generic_api_key', pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['""]?[A-Za-z0-9_\-]{16,}['""]?/gi },
  { name: 'generic_token', pattern: /(?:access[_-]?token|auth[_-]?token|secret[_-]?token)\s*[:=]\s*['""]?[A-Za-z0-9_\-]{16,}['""]?/gi },
];

function extractText(body: string | object): string {
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

export function detectSecrets(content: string | object): SecretDetectionResult {
  const text = extractText(content);

  for (const { name, pattern } of PATTERNS) {
    pattern.lastIndex = 0; // Reset stateful regex
    const match = pattern.exec(text);
    if (match) {
      return {
        detected: true,
        type: name,
        location: `index:${match.index}`,
        snippet: match[0].slice(0, 20) + '...',
      };
    }
  }

  return { detected: false };
}
