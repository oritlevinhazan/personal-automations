import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { sendPushNotification } from "../shared/push-notification.js";

const BOOKON_API = "https://bookon-bamba-b2c-api.azurewebsites.net";
const REFERRAL = "9F9A43B0-F415-4E03-BA8A-9C76805FE802";
const MIN_SEATS = 5;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // only used in continuous mode
const ALERTZY_KEY = process.env.ALERTZY_ACCOUNT_KEY;

const TARGET_DATE = "2026-08-31";

async function getAug31Slots() {
    const res = await fetch(
        `${BOOKON_API}/widget?referral=${REFERRAL}&languageCode=iw`,
        { headers: { "Content-Type": "application/json" } }
    );
    const data = await res.json();
    const slots = data?.widget?.products?.[0]?.productDateTimePrices ?? [];
    return slots.filter(s => s.date === TARGET_DATE);
}

async function checkCapacity(productDateId) {
    const res = await fetch(
        `${BOOKON_API}/capacity/current?productDateId=${productDateId}`,
        { headers: { "Content-Type": "application/json" } }
    );
    const data = await res.json();
    return data?.currentCapacity ?? 0;
}

async function poll() {
    console.log(`[${new Date().toISOString()}] Checking Aug 31 slots...`);

    let slots;
    try {
        slots = await getAug31Slots();
    } catch (err) {
        console.error("Failed to fetch slots:", err.message);
        if (ALERTZY_KEY) {
            await sendPushNotification(ALERTZY_KEY, "⚠️ במבה מוניטור - שגיאה", "לא הצלחתי לשלוף את הסלוטים");
        }
        return;
    }

    console.log(`  Found ${slots.length} Aug 31 slots`);

    const available = [];

    for (const slot of slots) {
        let capacity;
        try {
            capacity = await checkCapacity(slot.id);
        } catch (err) {
            console.error(`  Failed to check capacity for slot ${slot.id}:`, err.message);
            continue;
        }

        console.log(`  ${slot.date} ${slot.time} (id=${slot.id}): ${capacity} seats (threshold: ${MIN_SEATS})`);

        if (capacity >= MIN_SEATS) {
            available.push(`${slot.date} ${slot.time} (${capacity} מקומות)`);
        }
    }

    if (ALERTZY_KEY) {
        if (available.length > 0) {
            await sendPushNotification(
                ALERTZY_KEY,
                "🎉 מקום פנוי בסיור בארץ במבה!",
                available.join("\n")
            );
        } else if (process.env.SEND_SUMMARY === "true") {
            const runCount = process.env.DAILY_RUN_COUNT ? ` (${process.env.DAILY_RUN_COUNT} בדיקות היום)` : "";
            const msg = slots.length === 0
                ? `31.8 לא מופיע בלוח הזמנים${runCount}`
                : `נבדקו ${slots.length} זמנים ב-31.8 — אין מספיק מקומות (צריך ${MIN_SEATS})${runCount}`;
            await sendPushNotification(ALERTZY_KEY, "🔍 במבה — סיכום יומי", msg);
        }
    }
}

async function main() {
    if (!ALERTZY_KEY) {
        console.warn("Warning: ALERTZY_ACCOUNT_KEY not set. Notifications will be printed to console only.");
    }

    const continuous = process.argv.includes("--continuous");

    console.log(`Bamba tour monitor started${continuous ? ` — polling every ${POLL_INTERVAL_MS / 60000} minutes` : " — single run"}`);
    console.log(`Looking for Aug 31, 2026 slots with ≥${MIN_SEATS} seats`);

    await poll();

    if (continuous) {
        setInterval(() => poll(), POLL_INTERVAL_MS);
    }
}

main().catch(console.error);
