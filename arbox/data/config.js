import dotenv from "dotenv";
dotenv.config();

export default {
  user_creds: {
    email: process.env.ARBOX_USER_EMAIL,
    password: process.env.ARBOX_USER_PASSWORD
  },
  alertzyAccountKey: process.env.ALERTZY_ACCOUNT_KEY,
  registerTime: "16:00:10",
  remindersTime: "10:00:00",
  maxClassesPerMonth: 9,
  // Your preffered coaches by priority on ascending order. 
  // Make sure the names appear axactly like in the Arbox app, (no need to mention all of them, only those you like)
  coach_priorities: 
  [],
  timezone: "Asia/Jerusalem",
};
