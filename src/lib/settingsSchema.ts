import { z } from "zod";

export const settingsInputSchema = z.object({
  alertEmail: z.string().trim().email().nullable(),
  workAddress: z.string().trim().min(1).nullable(),
});

export type SettingsInput = z.infer<typeof settingsInputSchema>;
