export type NotificationListingPayload = {
  title: string;
  url: string;
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  locationText: string | null;
  nearestStation: { name: string; walkingMinutes: number } | null;
  commute: { minutes: number; distanceMiles: number; approximate: boolean; mode: "car" | "transit" } | null;
};

export type NotificationPayload = {
  to: string;
  subject: string;
  watchName: string;
  listings: NotificationListingPayload[];
  pauseUrl?: string;
};

export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}
