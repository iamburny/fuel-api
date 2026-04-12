import { hashPassword, verifyPassword, createToken } from "../services/auth";
import { env } from "../config";
import jwt from "jsonwebtoken";

describe("hashPassword and verifyPassword", () => {
  it("round-trip works: hash then verify returns true", async () => {
    const password = "correct-horse-battery-staple";
    const hashed = await hashPassword(password);

    expect(hashed).not.toBe(password);
    expect(await verifyPassword(password, hashed)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const hashed = await hashPassword("right-password");
    expect(await verifyPassword("wrong-password", hashed)).toBe(false);
  });
});

describe("createToken", () => {
  it("produces a JWT with sub claim", () => {
    const token = createToken(42);

    expect(typeof token).toBe("string");

    // Verify using the same secret the module uses
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    expect(decoded.sub).toBe(42);
    expect(decoded.exp).toBeDefined();
  });
});
