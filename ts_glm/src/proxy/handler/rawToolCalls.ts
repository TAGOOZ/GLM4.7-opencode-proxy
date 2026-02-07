import { PROXY_DEBUG } from "../constants.js";
import { truncate } from "../debug.js";
import { findTool, type ToolInfo } from "../tools/registry.js";
import {
  buildToolCallSignature,
  isNoOpEditArgs,
  normalizeToolName,
  parseToolCallArgs,
} from "./utils.js";

export type RawDispatchContext = {
  lastUser: string;
  hasToolResult: boolean;
  allowTodoWrite: boolean;
  recentFilePath: string | null;
};

export type PreparedRawToolCalls = {
  toolCalls: any[];
  signature: string;
};

type RawDispatchState = {
  signature: string;
  user: string;
};

export const prepareRawToolCalls = (
  rawCalls: any[],
  context: RawDispatchContext,
  registry?: Map<string, ToolInfo>,
  lastDispatch?: RawDispatchState,
): PreparedRawToolCalls | null => {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return null;
  const seen = new Set<string>();
  const keptCalls: any[] = [];
  const signatures: string[] = [];
  let droppedTodoWrite = 0;
  let droppedNoOpEdits = 0;
  let droppedDuplicates = 0;
  let repairedMissingPath = 0;

  for (const call of rawCalls) {
    const toolName = normalizeToolName(call?.function?.name || call?.name || "");
    if (!toolName) continue;
    if (toolName === "todowrite" && !context.allowTodoWrite) {
      droppedTodoWrite += 1;
      continue;
    }

    const args = parseToolCallArgs(call);
    if (args && isNoOpEditArgs(toolName, args)) {
      droppedNoOpEdits += 1;
      continue;
    }
    if (args && context.hasToolResult && context.recentFilePath) {
      const isPathRepairableTool =
        toolName === "read" ||
        toolName === "readfile" ||
        toolName === "write" ||
        toolName === "writefile" ||
        toolName === "edit" ||
        toolName === "editfile" ||
        toolName === "applypatch" ||
        toolName === "patch";
      const hasPath =
        typeof args.path === "string" && args.path.trim().length > 0
          ? true
          : typeof (args as any).filePath === "string" &&
              String((args as any).filePath).trim().length > 0
            ? true
            : typeof (args as any).file_path === "string" &&
                String((args as any).file_path).trim().length > 0
              ? true
              : false;
      if (isPathRepairableTool && !hasPath) {
        const resolvedName = String(call?.function?.name || call?.name || "");
        const toolInfo = registry ? findTool(registry, resolvedName || toolName) : null;
        const pathKey = toolInfo?.argKeys?.includes("filePath")
          ? "filePath"
          : toolInfo?.argKeys?.includes("file_path")
            ? "file_path"
            : toolInfo?.argKeys?.includes("path")
              ? "path"
              : "path";
        (args as any)[pathKey] = context.recentFilePath;
        if (call?.function && typeof call.function === "object") {
          call.function.arguments = JSON.stringify(args);
        } else if (call && typeof call === "object") {
          call.arguments = JSON.stringify(args);
        }
        repairedMissingPath += 1;
      }
    }

    const signature = buildToolCallSignature(call);
    if (signature && seen.has(signature)) {
      droppedDuplicates += 1;
      continue;
    }
    if (signature) {
      seen.add(signature);
      signatures.push(signature);
    }
    keptCalls.push(call);
  }

  if (PROXY_DEBUG && (droppedTodoWrite || droppedNoOpEdits || droppedDuplicates || repairedMissingPath)) {
    console.log(
      "proxy_debug raw_preprocess:",
      JSON.stringify({
        droppedTodoWrite,
        droppedNoOpEdits,
        droppedDuplicates,
        repairedMissingPath,
        inputCount: rawCalls.length,
        keptCount: keptCalls.length,
      }),
    );
  }

  if (keptCalls.length === 0) return null;
  const batchSignature = signatures.join("||");
  if (
    context.hasToolResult &&
    context.lastUser &&
    batchSignature &&
    lastDispatch?.signature &&
    lastDispatch?.user &&
    batchSignature === lastDispatch.signature &&
    context.lastUser === lastDispatch.user
  ) {
    if (PROXY_DEBUG) {
      console.log(
        "proxy_debug repeated_raw_suppressed:",
        JSON.stringify({
          signature: truncate(batchSignature, 240),
        }),
      );
    }
    return null;
  }

  return {
    toolCalls: keptCalls,
    signature: batchSignature,
  };
};
