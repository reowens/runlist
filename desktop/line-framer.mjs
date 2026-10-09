// Retain incoming chunks until a newline, then concatenate once. Repeatedly
// copying a growing multi-MiB draft frame makes allocation quadratic in size.
export function createLineFramer({maximum, onFrame, onOverflow}) {
  let chunks = [], bytes = 0, closed = false;
  const overflow = () => { closed = true; chunks = []; bytes = 0; onOverflow(); };
  return {
    write(chunk) {
      if (closed) return false;
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start);
        const stop = end < 0 ? chunk.length : end;
        const length = stop - start;
        if (bytes + length > maximum) { overflow(); return false; }
        if (length) { chunks.push(chunk.subarray(start, stop)); bytes += length; }
        if (end < 0) return true;
        const line = (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes)).toString('utf8');
        chunks = []; bytes = 0;
        if (onFrame(line) === false) { closed = true; return false; }
        start = end + 1;
      }
      return true;
    },
    // An unterminated frame is never accepted at EOF or after an input error.
    discard() { closed = true; chunks = []; bytes = 0; }
  };
}
