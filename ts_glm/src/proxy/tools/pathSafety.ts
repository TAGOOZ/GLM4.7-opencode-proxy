const SAFE_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist"]);

const isAbsolutePathLike = (input: string): boolean => {
  const trimmed = input.trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.startsWith("//")) return true;
  if (/^[a-zA-Z]:/.test(trimmed)) return true; // Windows drive paths (C:\ or C:/ or C:relative)
  if (trimmed.startsWith("\\")) return true; // Windows rooted path
  return false;
};

const isUnsafePathInput = (input: string): boolean => {
  const trimmed = input.trim();
  if (!trimmed) return true;
  if (trimmed.includes("\0")) return true;
  if (trimmed.startsWith("~")) return true;
  if (isAbsolutePathLike(trimmed)) return true;
  if (/(^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed)) return true;
  return false;
};

const isSensitivePath = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : normalized;

  if (parts.includes(".ssh")) return true;
  if (parts.includes(".git")) return true;

  if (base === ".env") return true;
  if (base.startsWith(".env.")) {
    const suffix = base.slice(".env.".length);
    if (!SAFE_ENV_SUFFIXES.has(suffix)) return true;
  }

  if (base === ".npmrc") return true;
  if (base === ".pypirc") return true;
  if (base === ".netrc") return true;

  if (base === "id_rsa" || base === "id_ed25519") return true;

  if (/^creds?\b/i.test(base)) return true;
  if (/^credentials?\b/i.test(base)) return true;

  const fileName = base.replace(/\.[a-z0-9]{1,10}$/i, "");
  const compact = fileName.replace(/[^a-z0-9]/g, "");
  const keyish = [
    "apikey",
    "accesskey",
    "secretkey",
    "privatekey",
    "sshkey",
    "gpgkey",
    "signingkey",
    "encryptionkey",
  ];
  if (keyish.some((k) => compact.includes(k))) return true;

  // Token-based matches (api_key, private-key, etc). Avoid substring false positives like "monkey.ts".
  const tokens = fileName.split(/[._-]+/).filter(Boolean);
  const hasKey = tokens.includes("key") || tokens.includes("keys");
  if (hasKey) {
    const qualifiers = new Set([
      "api",
      "access",
      "secret",
      "private",
      "ssh",
      "gpg",
      "signing",
      "encryption",
    ]);
    if (tokens.some((t) => qualifiers.has(t))) return true;
  }

  return false;
};

export { isSensitivePath, isUnsafePathInput };

