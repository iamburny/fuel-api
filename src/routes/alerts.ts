import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../services/auth";

const router = Router();

router.use(requireAuth);

function alertDto(a: {
  id: number;
  latitude: number;
  longitude: number;
  radiusMiles: number;
  fuelType: string;
  notify: boolean;
  label: string | null;
}) {
  return {
    id: a.id,
    latitude: a.latitude,
    longitude: a.longitude,
    radius_miles: a.radiusMiles,
    fuel_type: a.fuelType,
    notify: a.notify,
    label: a.label,
  };
}

/** GET /api/alerts — the current user's area alert subscriptions. */
router.get("/", async (req: Request, res: Response) => {
  const subs = await prisma.alertSubscription.findMany({
    where: { userId: (req as any).userId },
    orderBy: { createdAt: "desc" },
  });
  res.json(subs.map(alertDto));
});

/** POST /api/alerts — subscribe to price drops within a radius of a point. */
router.post("/", async (req: Request, res: Response) => {
  const {
    latitude,
    longitude,
    radius_miles = 10,
    fuel_type = "E10",
    label = null,
  } = req.body ?? {};

  if (typeof latitude !== "number" || typeof longitude !== "number") {
    res.status(400).json({ detail: "latitude and longitude are required numbers" });
    return;
  }
  if (typeof radius_miles !== "number" || radius_miles <= 0 || radius_miles > 100) {
    res.status(400).json({ detail: "radius_miles must be a number between 0 and 100" });
    return;
  }

  const sub = await prisma.alertSubscription.create({
    data: {
      userId: (req as any).userId,
      latitude,
      longitude,
      radiusMiles: radius_miles,
      fuelType: fuel_type,
      label,
    },
  });

  res.status(201).json(alertDto(sub));
});

/** DELETE /api/alerts/:id — remove one of the user's own subscriptions. */
router.delete("/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sub = await prisma.alertSubscription.findFirst({
    where: { id, userId: (req as any).userId },
  });
  if (!sub) {
    res.status(404).json({ detail: "Subscription not found" });
    return;
  }

  await prisma.alertSubscription.delete({ where: { id } });
  res.status(204).send();
});

export default router;
