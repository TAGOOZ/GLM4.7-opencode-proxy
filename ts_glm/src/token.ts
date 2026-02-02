export const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const payload = token.split(".")[1] || "";
    if (!payload) return null;
    const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
    const decoded = Buffer.from(payload + pad, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const getUserIdFromToken = (token: string): string => {
  const payload = decodeJwtPayload(token);
  if (payload && typeof payload.id === "string") {
    return payload.id;
  }
  return "";
};
