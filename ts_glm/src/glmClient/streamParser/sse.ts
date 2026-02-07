const parseSseLines = (
  buffer: string,
  debugStream: boolean,
  options?: { flush?: boolean },
): { dataLines: string[]; rest: string } => {
  const dataLines: string[] = [];
  let start = 0;

  const recordLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    let dataStr = line.slice(5);
    if (dataStr.startsWith(" ")) dataStr = dataStr.slice(1);
    dataStr = dataStr.trim();
    if (debugStream) {
      const snippet = dataStr.length > 500 ? `${dataStr.slice(0, 500)}...` : dataStr;
      console.error(`[glm_debug] raw: ${snippet}`);
    }
    dataLines.push(dataStr);
  };

  while (true) {
    const nl = buffer.indexOf("\n", start);
    if (nl === -1) break;
    let line = buffer.slice(start, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = nl + 1;
    recordLine(line);
  }

  let rest = buffer.slice(start);
  if (options?.flush && rest) {
    recordLine(rest.trimEnd());
    rest = "";
  }

  return { dataLines, rest };
};

export { parseSseLines };
