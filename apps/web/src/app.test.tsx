import render from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { Landing } from "./app.js";

describe("public landing", () => {
  it("stays simple and exposes the exact headline with email actions", () => {
    const html = render(<Landing onAuthenticated={() => undefined} />);
    expect(html).toContain("The todo manager your friends told you about");
    expect(html).toContain("Sign up");
    expect(html).toContain("Log in");
    expect(html).not.toContain("feature-grid");
  });
});
