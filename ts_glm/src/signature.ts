import crypto from "crypto";

const SIGNATURE_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%";

const hmacSha256Hex = (key: string, message: string): string => {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
};

const promptB64 = (prompt: string): string => {
  return Buffer.from(prompt, "utf-8").toString("base64");
};

export const buildSortedPayload = (timestamp: number, requestId: string, userId: string): string => {
  const items: Record<string, string> = {
    requestId,
    timestamp: String(timestamp),
    user_id: userId,
  };
  const ordered = Object.entries(items).sort((a, b) => a[0].localeCompare(b[0]));
  const flat: string[] = [];
  for (const [key, value] of ordered) {
    flat.push(key, value);
  }
  return flat.join(",");
};

export const generateSignature = (sortedPayload: string, prompt: string, timestamp: number): string => {
  const windowId = Math.floor(timestamp / 300000);
  const subkey = hmacSha256Hex(SIGNATURE_KEY, String(windowId));
  const data = `${sortedPayload}|${promptB64(prompt)}|${timestamp}`;
  return hmacSha256Hex(subkey, data);
};

export type SignatureOk = {
  success: true;
  timestamp: number;
  request_id: string;
  signature: string;
  sorted_payload: string;
};

export type SignatureErr = { success: false; error: string };

export type SignatureResult = SignatureOk | SignatureErr;

export const generateRequestParams = (
  prompt: string,
  userId: string,
  timestamp?: number,
  requestId?: string,
): SignatureOk => {
  const ts = timestamp ?? Date.now();
  const rid = requestId ?? crypto.randomUUID();
  const sortedPayload = buildSortedPayload(ts, rid, userId);
  const signature = generateSignature(sortedPayload, prompt, ts);
  return {
    success: true,
    timestamp: ts,
    request_id: rid,
    signature,
    sorted_payload: sortedPayload,
  };
};

export const getSignatureSync = (prompt: string, userId = ""): SignatureResult => {
  try {
    return generateRequestParams(prompt, userId);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
};
