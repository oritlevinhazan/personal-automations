import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { sendPushNotification } from "../shared/push-notification.js";

const EVENT_ID = "6a50ee3140c30dd896e74711";
const EVENT_URL = "https://www.eventer.co.il/mesiba2alehet";
const API_URL = `https://www.eventer.co.il/events/${EVENT_ID}/ticketTypes.js`;
const ALERTZY_KEY = process.env.ALERTZY_ACCOUNT_KEY;

async function check() {
    console.log(`[${new Date().toISOString()}] Checking ticket availability...`);

    let data;
    try {
        const res = await fetch(API_URL, { headers: { "Referer": EVENT_URL } });
        data = await res.json();
    } catch (err) {
        console.error("Failed to fetch ticket data:", err.message);
        if (ALERTZY_KEY) {
            await sendPushNotification(ALERTZY_KEY, "⚠️ אוונטר מוניטור - שגיאה", "לא הצלחתי לשלוף נתוני כרטיסים");
        }
        return;
    }

    const tickets = data?.ticketTypes ?? [];
    const totalRemaining = data?.totalRemaining ?? 0;

    console.log(`  ticketTypes: ${tickets.length}, totalRemaining: ${totalRemaining}`);

    if (ALERTZY_KEY) {
        if (tickets.length > 0) {
            const names = tickets.map(t => t.name || "כרטיס").join(", ");
            await sendPushNotification(
                ALERTZY_KEY,
                "🎉 כרטיסים זמינים! מסיבתה נוסטלגיה",
                `${names}\n${EVENT_URL}`
            );
        } else {
            await sendPushNotification(
                ALERTZY_KEY,
                "🔍 אוונטר מוניטור - בדיקה תקינה",
                `כרטיסים עדיין אזלו | totalRemaining: ${totalRemaining}`
            );
        }
    }
}

check().catch(console.error);
