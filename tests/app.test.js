const request = require("supertest");
const app = require("../app");

describe("events-service app", () => {
  it("GET /health returns 200 UP", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "UP" });
  });

  it("GET /api returns service metadata without auth", async () => {
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("Events & Courses Service API");
  });

  it("GET /api/events requires authentication", async () => {
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(400);
  });
});
