// Wire protocol shared by the host agent and the in-container clients.
//
// Every connection starts with exactly one newline-terminated JSON *hello*
// line from the client, answered by one newline-terminated JSON *ack* line
// from the server. Afterwards both sides speak newline-delimited JSON frames.
//
// Binary payloads travel base64-encoded inside frames. That costs ~33% but
// keeps a single, debuggable, order-preserving framing for stdio streams and
// for the multiplexed TCP tunnel alike.

export const PROTO_VERSION = 1;

// ---- process frames (ops: mcp, exec) ---------------------------------------
// client -> server : {t:'i', b} stdin chunk | {t:'ie'} stdin EOF | {t:'sig', s}
// server -> client : {t:'o', b} stdout      | {t:'e', b} stderr  | {t:'x', c, s}

// ---- tunnel frames (op: relay) ---------------------------------------------
// server -> client : {t:'conn', id, port} | {t:'d', id, b} | {t:'close', id}
// client -> server : {t:'d', id, b} | {t:'close', id} | {t:'connerr', id, m}
// client -> server : {t:'hb'}  (heartbeat)

export const b64 = (buf) => Buffer.from(buf).toString('base64');
export const unb64 = (s) => Buffer.from(s, 'base64');

/**
 * Reads exactly one newline-terminated JSON line from a socket, then hands the
 * remaining bytes back so the caller can switch the socket into frame mode
 * without losing data that arrived in the same TCP segment.
 */
export function readHello(socket, { limit = 1 << 20, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;

    const timer = setTimeout(() => fail(new Error('handshake timeout')), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', fail);
      socket.off('end', onEnd);
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const onEnd = () => fail(new Error('socket closed during handshake'));

    const onData = (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > limit) fail(new Error('handshake line too long'));
        return;
      }
      const line = buf.subarray(0, nl).toString('utf8');
      const rest = buf.subarray(nl + 1);
      done = true;
      cleanup();
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        reject(new Error(`malformed handshake: ${err.message}`));
        return;
      }
      resolve({ hello: parsed, rest });
    };

    socket.on('data', onData);
    socket.on('error', fail);
    socket.on('end', onEnd);
  });
}

/**
 * Newline-delimited JSON frame reader. Feed it raw chunks; it emits parsed
 * objects. Kept deliberately allocation-simple: MCP payloads are frequently
 * hundreds of kilobytes and a naive per-byte scan shows up in profiles.
 */
export class FrameReader {
  #buf = Buffer.alloc(0);
  #onFrame;
  #onError;

  constructor(onFrame, onError = () => {}) {
    this.#onFrame = onFrame;
    this.#onError = onError;
  }

  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buf.subarray(start, nl);
      start = nl + 1;
      if (line.length === 0) continue;
      try {
        this.#onFrame(JSON.parse(line.toString('utf8')));
      } catch (err) {
        this.#onError(err);
      }
    }
    this.#buf = start === 0 ? this.#buf : this.#buf.subarray(start);
  }
}

/** Writes one frame. Returns false when the socket wants back-pressure. */
export function writeFrame(socket, obj) {
  if (!socket || socket.destroyed) return false;
  return socket.write(JSON.stringify(obj) + '\n');
}
