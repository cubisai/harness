/**
 * Incremental Server-Sent-Events parser for a response body that arrives in
 * arbitrary text pieces: a line or an event may be split across `push` calls.
 * `onData` fires once per event with its `data` lines joined by "\n".
 */
export function createSseParser(onData: (data: string) => void): { push(text: string): void; end(): void } {
  let buffer = "";
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) return;
    const joined = dataLines.join("\n");
    dataLines = [];
    onData(joined);
  };

  const handleLine = (line: string): void => {
    // A blank line terminates the event.
    if (line === "") {
      flush();
      return;
    }
    // Comment lines start with ":"; ignore them and any non-data field.
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  };

  return {
    push(text: string): void {
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        handleLine(line);
        newline = buffer.indexOf("\n");
      }
    },
    end(): void {
      // Flush a trailing line with no newline, then any pending event.
      if (buffer.length > 0) {
        let line = buffer;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = "";
        handleLine(line);
      }
      flush();
    },
  };
}
