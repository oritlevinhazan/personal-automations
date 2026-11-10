// Usage: node shared/notify.js "<title>" "<message>"
import dotenv from "dotenv";
dotenv.config();
import { sendPushNotification } from "./push-notification.js";
await sendPushNotification(process.env.ALERTZY_ACCOUNT_KEY, process.argv[2], process.argv[3]);
