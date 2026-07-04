import cron from "node-cron";
import { runCrawlCycle } from "./crawl/runCrawlCycle";
import { flushDailyDigests, flushHourlyDigests } from "./notify/digest";

const CRAWL_INTERVAL_MINUTES = Number(process.env.CRAWL_INTERVAL_MINUTES ?? 20);
const DIGEST_DAILY_HOUR = Number(process.env.DIGEST_DAILY_HOUR ?? 8);

let started = false;

export function startScheduler() {
  if (started) return;
  started = true;

  const crawlExpr = `*/${CRAWL_INTERVAL_MINUTES} * * * *`;
  cron.schedule(crawlExpr, async () => {
    try {
      const summary = await runCrawlCycle();
      console.log("[scheduler] crawl cycle:", summary);
    } catch (err) {
      console.error("[scheduler] crawl cycle failed:", err);
    }
  });

  cron.schedule("5 * * * *", async () => {
    try {
      const result = await flushHourlyDigests();
      console.log("[scheduler] hourly digest:", result);
    } catch (err) {
      console.error("[scheduler] hourly digest failed:", err);
    }
  });

  cron.schedule(`0 ${DIGEST_DAILY_HOUR} * * *`, async () => {
    try {
      const result = await flushDailyDigests();
      console.log("[scheduler] daily digest:", result);
    } catch (err) {
      console.error("[scheduler] daily digest failed:", err);
    }
  });

  console.log(
    `[scheduler] started — crawl every ${CRAWL_INTERVAL_MINUTES}m, hourly digest at :05, daily digest at ${DIGEST_DAILY_HOUR}:00`,
  );
}
