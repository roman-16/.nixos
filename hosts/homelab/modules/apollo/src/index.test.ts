import { describe, expect, it } from "bun:test";

import { handler } from "./index.ts";

describe("handler", () => {
  it("returns ok on /health", async () => {
    const res = handler(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("greets on other paths", async () => {
    const res = handler(new Request("http://localhost/"));
    expect(await res.text()).toBe("hello from apollo\n");
  });
});
