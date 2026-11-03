// Test setup file
process.env.NODE_ENV = "test";
process.env.PORT = "4011";
process.env.MONGO_URI = "mongodb://localhost:27017/events-service-test";
process.env.AUTH_BYPASS_ENABLED = "true";
process.env.JWT_SECRET = "test-jwt-secret-key";
// P5: dedicated check-in pass secret (required at startup; must differ from JWT_SECRET).
process.env.CHECKIN_TOKEN_SECRET = "test-checkin-token-secret-0123456789abcdef";

jest.mock("../rabbitMQ", () => ({
  initEventSystem: jest.fn().mockResolvedValue(),
  setupConsumers: jest.fn().mockResolvedValue(),
  shutdownEventSystem: jest.fn().mockResolvedValue(),
}));

jest.mock("../config/db", () => ({
  mongooseConnection: jest.fn().mockResolvedValue(),
}));

// Test harness: supertest's `request(app)` binds an ephemeral server on all interfaces (`[::]`, port 0)
// but then connects to 127.0.0.1. On a developer machine an unrelated app listening on 127.0.0.1 only
// (seen: Postman, Ollama, a leftover local mongod) can hold that same port number, and the test request
// is answered by that app instead (wrong status such as 200/404, or "socket hang up"). Connect to the
// loopback of the address family the server actually bound, which such a listener cannot intercept.
const { Test } = require("supertest");
const { Server: TlsServer } = require("tls");

Test.prototype.serverAddress = function serverAddress(app, path) {
  if (!app.address()) this._server = app.listen(0);
  const { port, family } = app.address();
  const host = family === "IPv6" ? "[::1]" : "127.0.0.1";
  const protocol = app instanceof TlsServer ? "https" : "http";
  return `${protocol}://${host}:${port}${path}`;
};
