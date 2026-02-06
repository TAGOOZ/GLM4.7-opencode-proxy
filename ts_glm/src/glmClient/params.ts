import { USER_AGENT } from "./constants.js";

export function buildCompletionParams(options: {
  chatId: string;
  timestamp: number;
  requestId: string;
  userId: string;
  token: string;
}): Record<string, string> {
  const now = new Date();
  let tzOffsetMin = 0;
  try {
    tzOffsetMin = -now.getTimezoneOffset();
  } catch {
    tzOffsetMin = 0;
  }

  const params: Record<string, string> = {
    timestamp: String(options.timestamp),
    requestId: options.requestId,
    user_id: options.userId,
    version: "0.0.1",
    platform: "web",
    token: options.token,
    user_agent: USER_AGENT,
    language: "en-US",
    languages: "en-US,en",
    timezone: "UTC",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    screen_resolution: "1920x1080",
    viewport_height: "927",
    viewport_width: "1047",
    viewport_size: "1047x927",
    color_depth: "24",
    pixel_ratio: "1",
    current_url: `https://chat.z.ai/c/${options.chatId}`,
    pathname: `/c/${options.chatId}`,
    search: "",
    hash: "",
    host: "chat.z.ai",
    hostname: "chat.z.ai",
    protocol: "https:",
    referrer: "https://chat.z.ai/",
    title: "Z.ai Chat - Free AI powered by GLM-4.7 & GLM-4.6",
    timezone_offset: String(tzOffsetMin),
    local_time: now.toISOString().replace("Z", ".000Z"),
    utc_time: now.toUTCString(),
    is_mobile: "false",
    is_touch: "false",
    max_touch_points: "0",
    browser_name: "Chrome",
    os_name: "Linux",
  };
  params.signature_timestamp = String(options.timestamp);
  return params;
}

