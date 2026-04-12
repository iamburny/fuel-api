import { env } from "../config";

/**
 * Client for the UK Government Fuel Finder API.
 * Handles OAuth 2.0 client-credentials token lifecycle and paginated data fetching.
 */
class FuelFinderClient {
  private token: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;

  // ── Token management ───────────────────────────────

  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return;

    console.log("[FuelFinder] Refreshing OAuth token");
    const res = await fetch(
      `${env.FUEL_FINDER_BASE_URL}/api/v1/oauth/generate_access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.FUEL_FINDER_CLIENT_ID,
          client_secret: env.FUEL_FINDER_CLIENT_SECRET,
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token request failed (${res.status}): ${text}`);
    }

    const body = await res.json();
    const tokenData = body?.data;
    if (!tokenData?.access_token) {
      throw new Error(`Token response missing access_token: ${JSON.stringify(body)}`);
    }
    this.token = tokenData.access_token;
    this.refreshToken = tokenData.refresh_token ?? null;
    this.tokenExpiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000;
    console.log(`[FuelFinder] Token refreshed, expires in ${tokenData.expires_in ?? 3600}s`);
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  // ── Paginated fetch helper ─────────────────────────

  /**
   * The Information Recipient API paginates via `batch-number` (1-indexed,
   * 500 items per batch) and optionally accepts `effective-start-timestamp`
   * (YYYY-MM-DD) for delta sync. Successful responses are a flat JSON array;
   * only errors are wrapped in `{success, data, error}`.
   */
  private static readonly BATCH_SIZE = 500;

  private async fetchPaginated(
    path: string,
    effectiveStartTimestamp?: string
  ): Promise<any[]> {
    await this.ensureToken();
    const all: any[] = [];
    let batchNumber = 1;

    while (true) {
      const url = new URL(path, env.FUEL_FINDER_BASE_URL);
      url.searchParams.set("batch-number", String(batchNumber));
      if (effectiveStartTimestamp) {
        url.searchParams.set("effective-start-timestamp", effectiveStartTimestamp);
      }

      const res = await fetch(url.toString(), { headers: this.authHeaders });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Fetch ${path} batch ${batchNumber} failed (${res.status}): ${text}`
        );
      }

      const body = await res.json();
      if (!Array.isArray(body)) {
        throw new Error(
          `Expected array response from ${path} batch ${batchNumber}, got: ${JSON.stringify(body).slice(0, 300)}`
        );
      }

      console.log(
        `[FuelFinder] ${path} batch ${batchNumber}: ${body.length} items`
      );

      all.push(...body);

      // Last batch is signalled by a partial (< BATCH_SIZE) response.
      if (body.length < FuelFinderClient.BATCH_SIZE) break;
      batchNumber++;
    }

    return all;
  }

  // ── Public methods ─────────────────────────────────

  async fetchStations(): Promise<any[]> {
    const stations = await this.fetchPaginated("/api/v1/pfs");
    console.log(`[FuelFinder] Total stations fetched: ${stations.length}`);
    return stations;
  }

  async fetchFuelPrices(): Promise<any[]> {
    const prices = await this.fetchPaginated("/api/v1/pfs/fuel-prices");
    console.log(`[FuelFinder] Total price records fetched: ${prices.length}`);
    return prices;
  }
}

export const fuelFinderClient = new FuelFinderClient();
