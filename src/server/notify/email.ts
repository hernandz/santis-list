import { Resend } from "resend";
import nodemailer from "nodemailer";
import { commuteModeEmoji } from "@/lib/commuteMode";
import type { NotificationChannel, NotificationListingPayload, NotificationPayload } from "./types";

function formatCommute(commute: NotificationListingPayload["commute"]): string | null {
  if (!commute) return null;
  const distance = commute.distanceMiles.toFixed(1);
  return `${commuteModeEmoji(commute.mode)} ${commute.minutes} min (${distance} mi)${commute.approximate ? " ~" : ""} to work`;
}

function formatStation(nearestStation: NotificationListingPayload["nearestStation"]): string | null {
  if (!nearestStation) return null;
  return `${nearestStation.walkingMinutes} min walk to ${nearestStation.name}`;
}

function renderHtml(payload: NotificationPayload): string {
  const rows = payload.listings
    .map((l) => {
      const details = [
        l.price != null ? `$${l.price.toLocaleString()}` : null,
        l.bedrooms != null ? `${l.bedrooms}bd` : null,
        l.bathrooms != null ? `${l.bathrooms}ba` : null,
        l.locationText,
      ]
        .filter(Boolean)
        .join(" · ");

      const extras = [formatStation(l.nearestStation), formatCommute(l.commute)].filter(Boolean).join(" · ");

      return `<li><a href="${l.url}">${l.title}</a><br/><span style="color:#666">${details}</span>${extras ? `<br/><span style="color:#999;font-size:12px">${extras}</span>` : ""}</li>`;
    })
    .join("");

  const pauseLine = payload.pauseUrl
    ? `<p style="color:#999;font-size:12px">Getting too many of these? <a href="${payload.pauseUrl}">Pause this search</a>.</p>`
    : "";

  return `<p>New listings for <strong>${payload.watchName}</strong>:</p><ul>${rows}</ul>${pauseLine}`;
}

function renderText(payload: NotificationPayload): string {
  const listingsText = payload.listings
    .map((l) => {
      const extras = [formatStation(l.nearestStation), formatCommute(l.commute)].filter(Boolean).join(" · ");
      return `${l.title} — ${l.price != null ? `$${l.price}` : "?"}${extras ? `\n${extras}` : ""}\n${l.url}`;
    })
    .join("\n\n");

  const pauseLine = payload.pauseUrl ? `\n\nGetting too many of these? Pause this search: ${payload.pauseUrl}` : "";
  return listingsText + pauseLine;
}

function buildEmailChannel(): NotificationChannel {
  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM;
  const smtpUrl = process.env.SMTP_URL;

  if (resendApiKey) {
    const resend = new Resend(resendApiKey);
    return {
      async send(payload) {
        await resend.emails.send({
          from: emailFrom ?? "alerts@example.com",
          to: payload.to,
          subject: payload.subject,
          html: renderHtml(payload),
          text: renderText(payload),
        });
      },
    };
  }

  if (smtpUrl) {
    const transport = nodemailer.createTransport(smtpUrl);
    return {
      async send(payload) {
        await transport.sendMail({
          from: emailFrom ?? "alerts@example.com",
          to: payload.to,
          subject: payload.subject,
          html: renderHtml(payload),
          text: renderText(payload),
        });
      },
    };
  }

  return {
    async send() {
      throw new Error(
        "No email provider configured — set RESEND_API_KEY or SMTP_URL in .env before sending notifications.",
      );
    },
  };
}

export const emailChannel: NotificationChannel = buildEmailChannel();
