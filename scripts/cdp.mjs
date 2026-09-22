/**
 * A dependency-free Chrome DevTools Protocol client.
 *
 * The screenshots in the README are captured by driving the real app rather than posed
 * by hand, which means talking to Electron's debugger. A WebSocket library would be the
 * obvious way; this is about sixty lines and keeps the repo's dependency list honest.
 */

import { createHash } from 'node:crypto';
import { connect } from 'node:net';

export async function attach(port = 9222) {
  const list = await (await fetch(`http://localhost:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error(`no page on :${port} — is the app running with --remote-debugging-port=${port}?`);

  const url = new URL(page.webSocketDebuggerUrl);
  const sock = connect(Number(url.port), url.hostname);
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

  const key = createHash('sha1').update(String(Math.random())).digest('base64');
  sock.write(
    `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );

  const pending = new Map();
  let buf = Buffer.alloc(0);
  let handshook = false;

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshook) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      buf = buf.subarray(i + 4);
      handshook = true;
    }
    // Frames from the server are never masked, so the payload starts right after the
    // length. Anything over 64 KiB arrives as a 127-length frame — a screenshot always
    // does.
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const msg = JSON.parse(buf.subarray(off, off + len).toString());
      buf = buf.subarray(off + len);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;

  function send(method, params) {
    const id = nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = Buffer.alloc(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0xfe;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    sock.write(Buffer.concat([header, mask, payload]));
    return new Promise((resolve) => pending.set(id, resolve));
  }

  await new Promise((r) => setTimeout(r, 300));

  return {
    /** Run an expression in the page and return its value. Throws what the page threw. */
    async eval(expression) {
      const msg = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const thrown = msg.result?.exceptionDetails;
      if (thrown) throw new Error(thrown.exception?.description ?? thrown.text);
      return msg.result?.result?.value;
    },

    /**
     * A REAL pointer event at the centre of an element.
     *
     * `element.click()` would be simpler and would also be a lie: it ignores
     * `-webkit-app-region`, so it passes happily against a control that is dead to an
     * actual pointer — which is exactly how the nav's search box and tabs once shipped
     * broken.
     */
    async pointer(selectorExpr, { click = false } = {}) {
      const at = await this.eval(
        `(() => { const e = ${selectorExpr}; if (!e) return null;
          const r = e.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (!at) throw new Error(`no element for ${selectorExpr}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      if (click) {
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1, buttons: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1, buttons: 0,
        });
      }
      return at;
    },

    /** Park the pointer somewhere harmless. */
    async move(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },

    async screenshot({ format = 'jpeg', quality = 88 } = {}) {
      const msg = await send('Page.captureScreenshot', { format, quality });
      return Buffer.from(msg.result.data, 'base64');
    },

    close() {
      sock.destroy();
    },
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until an expression is truthy, so waits are on the DOM rather than a guess. */
export async function until(cdp, expression, { timeout = 15000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await cdp.eval(expression)) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
    await wait(every);
  }
}
