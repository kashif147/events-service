/**
 * Test-harness proof (tests/setup.js): supertest requests must reach the server instance under test.
 *
 * Upstream supertest (lib/test.js serverAddress) builds `http://127.0.0.1:<port>` for a server that
 * Node bound on all interfaces (`::`). A different process/listener bound to 127.0.0.1 ONLY on the same
 * port number then answers the test request instead of the app. This file reproduces that collision
 * deterministically and proves the patched harness reaches the app: every app instance stamps a random
 * nonce header, and the response must carry the nonce of the instance the test created.
 */
const http = require("http");
const crypto = require("crypto");
const request = require("supertest");

function nonceServer() {
  const nonce = crypto.randomBytes(8).toString("hex");
  const server = http.createServer((req, res) => {
    res.setHeader("x-test-instance", nonce);
    res.end("app");
  });
  return { server, nonce };
}

const listen = (srv, ...args) =>
  new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(...args, () => {
      srv.off("error", reject);
      resolve();
    });
  });
const close = (srv) => new Promise((resolve) => (srv.listening ? srv.close(() => resolve()) : resolve()));

/** A fresh, unpatched copy of supertest's Test class (setup.js patches the cached module only). */
function upstreamTest() {
  let Test;
  jest.isolateModules(() => {
    ({ Test } = require("supertest"));
  });
  return Test;
}

describe("supertest target instance (harness)", () => {
  let dummy;
  let app;

  afterEach(async () => {
    await close(app?.server ?? { listening: false });
    await close(dummy ?? { listening: false });
    dummy = undefined;
    app = undefined;
  });

  test("forced port collision: upstream URL reaches the 127.0.0.1-only listener; the harness reaches the app", async () => {
    dummy = http.createServer((req, res) => {
      res.setHeader("x-test-instance", "DUMMY");
      res.statusCode = 418;
      res.end("dummy");
    });
    await listen(dummy, 0, "127.0.0.1");
    const port = dummy.address().port;

    app = nonceServer();
    try {
      await listen(app.server, port); // all interfaces, as supertest's app.listen(0) does
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        // Platform does not allow `::` and 127.0.0.1 binds on one port: the collision cannot occur here.
        console.warn("collision not reproducible on this platform (EADDRINUSE)");
        return;
      }
      throw e;
    }
    expect(app.server.address().family).toBe("IPv6");

    // Upstream behaviour: the URL targets 127.0.0.1 and is answered by the other listener.
    const UpstreamTest = upstreamTest();
    const upstreamUrl = new UpstreamTest(app.server, "get", "/probe").url;
    expect(upstreamUrl).toBe(`http://127.0.0.1:${port}/probe`);
    const upstream = await request(upstreamUrl).get("");
    expect(upstream.status).toBe(418);
    expect(upstream.headers["x-test-instance"]).toBe("DUMMY");

    // Patched harness: the same server object is reached on its own address family.
    const res = await request(app.server).get("/probe");
    expect(res.status).toBe(200);
    expect(res.headers["x-test-instance"]).toBe(app.nonce);
  });

  test("every request reaches the instance the test created (200 fresh ephemeral servers)", async () => {
    let mismatches = 0;
    for (let i = 0; i < 200; i += 1) {
      const { server, nonce } = nonceServer();
      const res = await request(server).get("/probe");
      if (res.headers["x-test-instance"] !== nonce) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });
});
