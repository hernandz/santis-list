import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => consoleErrors.push(String(err)));

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.selectOption("select", { label: "No saved-search filter (browse everything)" });
await page.waitForTimeout(800);

console.log("=== Commute header emoji ===");
const headerText = await page.locator("button:has-text('Commute')").textContent();
console.log("Header text:", headerText);

console.log("=== Sort dropdown options ===");
const sortSelect = page.locator("select:has(option:has-text('Newest'))");
console.log("Options:", await sortSelect.locator("option").allTextContents());

console.log("=== Sort by commute ===");
await sortSelect.selectOption({ label: "Commute to work: shortest first" });
await page.waitForTimeout(3000);
const rows = await page.locator("div.divide-y > a").allTextContents();
const mins = rows.map((r) => { const m = r.match(/(\d+) min \(([\d.]+) mi\)/); return m ? Number(m[1]) : null; });
console.log("Commute minutes in order:", mins.slice(0, 8));
console.log("Sorted ascending:", mins.every((v, i) => i === 0 || v === null || mins[i-1] === null || v >= mins[i-1]));

console.log("=== Console errors ===", consoleErrors.length ? consoleErrors : "none");
await browser.close();
