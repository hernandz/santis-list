import { z } from "zod";

export const settingsInputSchema = z.object({
  workAddress: z.string().trim().min(1).nullable(),
  useGoogleDirections: z.boolean().optional(),
  // Only required/checked when useGoogleDirections is being turned ON — see
  // the PUT handler. Never persisted.
  confirmPassword: z.string().optional(),
});

export type SettingsInput = z.infer<typeof settingsInputSchema>;
