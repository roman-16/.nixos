import { describe, expect, it } from "bun:test";

import { healthHandler } from "../src/health.ts";

describe("healthHandler", () => {
  it("returns ok on /health", async () => {
    const res = healthHandler(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("responds on other paths", async () => {
    const res = healthHandler(new Request("http://localhost/"));
    expect(await res.text()).toBe("apollo\n");
  });
});
