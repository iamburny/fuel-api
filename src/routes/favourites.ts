import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../services/auth";

const router = Router();

router.use(requireAuth);

/** GET /api/favourites */
router.get("/", async (req: Request, res: Response) => {
  const favs = await prisma.favourite.findMany({
    where: { userId: (req as any).userId },
    include: { station: true },
  });

  res.json(
    favs.map((f) => ({
      id: f.id,
      station_id: f.stationId,
      fuel_type: f.fuelType,
      notify_on_drop: f.notifyOnDrop,
      price_threshold_pence: f.priceThresholdPence,
      station: f.station
        ? {
            id: f.station.id,
            gov_id: f.station.govId,
            name: f.station.name,
            brand: f.station.brand,
            latitude: f.station.latitude,
            longitude: f.station.longitude,
          }
        : null,
    }))
  );
});

/** POST /api/favourites */
router.post("/", async (req: Request, res: Response) => {
  const { station_id, fuel_type = "E10", notify_on_drop = true, price_threshold_pence } = req.body;

  const station = await prisma.station.findUnique({ where: { id: station_id } });
  if (!station) {
    res.status(404).json({ detail: "Station not found" });
    return;
  }

  const existing = await prisma.favourite.findUnique({
    where: { userId_stationId: { userId: (req as any).userId, stationId: station_id } },
  });
  if (existing) {
    res.status(409).json({ detail: "Already a favourite" });
    return;
  }

  const fav = await prisma.favourite.create({
    data: {
      userId: (req as any).userId,
      stationId: station_id,
      fuelType: fuel_type,
      notifyOnDrop: notify_on_drop,
      priceThresholdPence: price_threshold_pence ?? null,
    },
  });

  res.status(201).json({
    id: fav.id,
    station_id: fav.stationId,
    fuel_type: fav.fuelType,
    notify_on_drop: fav.notifyOnDrop,
    price_threshold_pence: fav.priceThresholdPence,
  });
});

/** DELETE /api/favourites/:id */
router.delete("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const fav = await prisma.favourite.findFirst({
    where: { id, userId: (req as any).userId },
  });
  if (!fav) {
    res.status(404).json({ detail: "Favourite not found" });
    return;
  }

  await prisma.favourite.delete({ where: { id } });
  res.status(204).send();
});

export default router;
