import { z } from "zod";
import { SUPPORTED_CITIES } from "@/lib/craigslistCities";

export const notifyFrequencyValues = ["IMMEDIATE", "HOURLY", "DAILY"] as const;

const supportedCityValues = SUPPORTED_CITIES.map((c) => c.value) as [string, ...string[]];

const baseWatchSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  city: z.enum(supportedCityValues),
  subareas: z.array(z.string().trim().min(1)),
  neighborhoods: z.array(z.string().trim().min(1)),
  minPrice: z.coerce.number().int().nonnegative().nullable().optional(),
  maxPrice: z.coerce.number().int().nonnegative().nullable().optional(),
  minBedrooms: z.coerce.number().int().nonnegative().nullable().optional(),
  minBathrooms: z.coerce.number().nonnegative().nullable().optional(),
  notifyFrequency: z.enum(notifyFrequencyValues),
  isActive: z.boolean(),
});

// Used for creation: defaults fill in fields the client omits entirely.
export const watchInputSchema = baseWatchSchema.extend({
  subareas: z.array(z.string().trim().min(1)).default([]),
  neighborhoods: z.array(z.string().trim().min(1)).default([]),
  notifyFrequency: z.enum(notifyFrequencyValues).default("IMMEDIATE"),
  isActive: z.boolean().default(true),
});

// Used for updates: no defaults, so an omitted field is left untouched rather
// than being reset (e.g. a PATCH that only sets isActive must not also reset
// notifyFrequency back to IMMEDIATE).
export const watchUpdateSchema = baseWatchSchema.partial();

export type WatchInput = z.infer<typeof watchInputSchema>;
export type WatchUpdate = z.infer<typeof watchUpdateSchema>;
