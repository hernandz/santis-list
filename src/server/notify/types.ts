export type NotificationListingPayload = {
  title: string;
  url: string;
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  locationText: string | null;
};

export type NotificationPayload = {
  to: string;
  subject: string;
  watchName: string;
  listings: NotificationListingPayload[];
};

export interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}
