import { requireAdminKey } from "../services/adminAuth";
import { env } from "../config";
import { Request, Response } from "express";

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("requireAdminKey", () => {
  it("rejects a request with no X-Admin-Key header", () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();

    requireAdminKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong key", () => {
    const req = { headers: { "x-admin-key": "totally-wrong-key" } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireAdminKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() with the correct key", () => {
    const req = { headers: { "x-admin-key": env.ADMIN_API_KEY } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireAdminKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
