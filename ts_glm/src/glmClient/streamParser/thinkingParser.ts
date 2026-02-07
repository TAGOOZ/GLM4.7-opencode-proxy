import type { StreamChunk } from "../types.js";

const createThinkingParser = () => {
  let pending = "";
  let inThinking = false;

  const emitText = (text: string, out: StreamChunk[]) => {
    if (!text) return;
    out.push({ type: inThinking ? "thinking" : "content", data: text });
  };

  const setThinking = (value: boolean, out: StreamChunk[]) => {
    if (value === inThinking) return;
    if (inThinking && !value) {
      out.push({ type: "thinking_end", data: "" });
    }
    inThinking = value;
  };

  const handleTag = (tag: string, out: StreamChunk[]) => {
    const match = tag.match(/^<\/?\s*([a-zA-Z0-9:-]+)/);
    const name = match?.[1]?.toLowerCase();
    if (name !== "think" && name !== "details") {
      emitText(tag, out);
      return;
    }
    const closing = tag.startsWith("</");
    setThinking(!closing, out);
  };

  return {
    push(text: string) {
      const out: StreamChunk[] = [];
      pending += text;
      while (pending) {
        const lt = pending.indexOf("<");
        if (lt === -1) {
          emitText(pending, out);
          pending = "";
          break;
        }
        if (lt > 0) {
          emitText(pending.slice(0, lt), out);
          pending = pending.slice(lt);
        }
        const gt = pending.indexOf(">", 1);
        if (gt === -1) break;
        const tag = pending.slice(0, gt + 1);
        pending = pending.slice(gt + 1);
        handleTag(tag, out);
      }
      return out;
    },
    setThinking(value: boolean) {
      const out: StreamChunk[] = [];
      setThinking(value, out);
      return out;
    },
    finalize() {
      const out: StreamChunk[] = [];
      if (pending) {
        const looksLikeTag = /^<\/?(details|think)\b/i.test(pending.trim());
        if (!looksLikeTag) {
          emitText(pending, out);
        }
        pending = "";
      }
      if (inThinking) {
        inThinking = false;
        out.push({ type: "thinking_end", data: "" });
      }
      return out;
    },
  };
};

const sanitizeThinkingText = (text: string) =>
  text
    .replace(/<\/?(details|think)[^>]*>/gi, "")
    .replace(/\btrue\">/gi, "")
    .replace(/^\s+/, "");

export { createThinkingParser, sanitizeThinkingText };
