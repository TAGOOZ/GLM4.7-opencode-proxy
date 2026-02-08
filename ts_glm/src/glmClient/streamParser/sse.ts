const parseSseLines = (
  buffer: string,
  debugStream: boolean,
  options?: { flush?: boolean },
): { dataLines: string[]; rest: string } => {
  const dataLines: string[] = [];
  let cursor = 0;
  const delimiter = /(?:\r?\n){2}/g;

  const recordEvent = (eventBlock: string) => {
    const dataParts: string[] = [];
    const lines = eventBlock.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let dataStr = line.slice(5);
      if (dataStr.startsWith(" ")) dataStr = dataStr.slice(1);
      dataParts.push(dataStr);
    }
    if (!dataParts.length) return;
    const dataStr = dataParts.join("\n").trim();
    if (!dataStr) return;
    if (debugStream) {
      const snippet = dataStr.length > 500 ? `${dataStr.slice(0, 500)}...` : dataStr;
      console.error(`[glm_debug] raw: ${snippet}`);
    }
    dataLines.push(dataStr);
  };

  while (true) {
    delimiter.lastIndex = cursor;
    const match = delimiter.exec(buffer);
    if (!match) break;
    const eventEnd = match.index;
    const eventBlock = buffer.slice(cursor, eventEnd);
    cursor = eventEnd + match[0].length;
    recordEvent(eventBlock);
  }

  let rest = buffer.slice(cursor);
  if (options?.flush && rest) {
    recordEvent(rest.trimEnd());
    rest = "";
  }

  return { dataLines, rest };
};

export { parseSseLines };
