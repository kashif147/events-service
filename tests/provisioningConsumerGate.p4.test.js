// Phase B / P4 - the provisioning step consumer is bound ONLY with PROVISIONING_CONSUMER=on (default: not bound).
const mockCalls = [];
jest.mock("@projectShell/rabbitmq-middleware", () => ({
  init: async () => {},
  publisher: {},
  shutdown: async () => {},
  consumer: {
    createQueue: async (q) => mockCalls.push(["createQueue", q]),
    bindQueue: async (q, ex, keys) => mockCalls.push(["bindQueue", q, ex, keys]),
    registerHandler: (t) => mockCalls.push(["registerHandler", t]),
    consume: async (q) => mockCalls.push(["consume", q]),
  },
}));
jest.mock("@projectShell/logging-lib", () => ({ createRabbitStructuredLogHandlers: () => ({}) }));
jest.mock("../config/bizLogger.js", () => ({ business: () => {} }));

beforeEach(() => { mockCalls.length = 0; jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { delete process.env.PROVISIONING_CONSUMER; jest.restoreAllMocks(); });

test("default (unset): no provisioning queue, binding or handler (the existing payment consumer is unchanged)", async () => {
  const { setupConsumers } = jest.requireActual("../rabbitMQ"); // tests/setup.js mocks ../rabbitMQ globally
  await setupConsumers();
  expect(mockCalls.map((c) => c[1])).toContain("events.accounts.events");
  expect(JSON.stringify(mockCalls)).not.toMatch(/provisioning/);
});

test("PROVISIONING_CONSUMER=on: exactly one queue bound to provisioning.events for step.requested only", async () => {
  process.env.PROVISIONING_CONSUMER = "on";
  const { setupConsumers } = jest.requireActual("../rabbitMQ"); // tests/setup.js mocks ../rabbitMQ globally
  await setupConsumers();
  const prov = mockCalls.filter((c) => JSON.stringify(c).includes("provisioning"));
  expect(prov).toEqual([
    ["createQueue", "events.provisioning.events"],
    ["bindQueue", "events.provisioning.events", "provisioning.events", ["tenant.provisioning.step.requested.v1"]],
    ["registerHandler", "tenant.provisioning.step.requested.v1"],
    ["consume", "events.provisioning.events"],
  ]);
});

test("any other value keeps it off", async () => {
  process.env.PROVISIONING_CONSUMER = "true";
  const { setupConsumers } = jest.requireActual("../rabbitMQ"); // tests/setup.js mocks ../rabbitMQ globally
  await setupConsumers();
  expect(JSON.stringify(mockCalls)).not.toMatch(/provisioning/);
});
