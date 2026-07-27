import { expect, test } from "bun:test";

import { greeting } from "../src/index";

test("greets a person", () => {
  expect(greeting("Paperbot")).toBe("Hello, Paperbot");
});
