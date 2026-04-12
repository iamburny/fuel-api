describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("produces valid config with defaults when no env vars are set", async () => {
    // Delete env vars so Zod defaults kick in
    delete process.env.PORT;
    delete process.env.POLL_INTERVAL_MINUTES;

    const { env } = await import("../config");

    expect(env.PORT).toBe(8000);
    expect(env.POLL_INTERVAL_MINUTES).toBe(30);
    expect(env.NODE_ENV).toBe("test");
    expect(env.JWT_SECRET).toBe("CHANGE-ME-in-production");
  });

  it("clamps POLL_INTERVAL_MINUTES=3 to 5 and warns", async () => {
    vi.stubEnv("POLL_INTERVAL_MINUTES", "3");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { env } = await import("../config");

    expect(env.POLL_INTERVAL_MINUTES).toBe(5);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("COMPLIANCE WARNING")
    );

    warnSpy.mockRestore();
  });

  it("keeps POLL_INTERVAL_MINUTES=30 unchanged", async () => {
    vi.stubEnv("POLL_INTERVAL_MINUTES", "30");

    const { env } = await import("../config");

    expect(env.POLL_INTERVAL_MINUTES).toBe(30);
  });
});
