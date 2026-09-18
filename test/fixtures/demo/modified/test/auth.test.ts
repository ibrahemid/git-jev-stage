import { login } from "../src/auth/login";

test("rejects unknown users", async () => {
  expect(await login({ body: { email: "x" } })).toBe(401);
});

test("rejects inactive users", async () => {
  expect(await login({ body: { email: "inactive" } })).toBe(401);
});
