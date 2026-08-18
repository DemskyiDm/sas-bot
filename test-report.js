require("dotenv").config();
const { requireAuth } = require("./api/admin");
const express = require("express");
const path = require("path");
const db = require("./db");
const { Telegraf } = require("telegraf");
const {
  handleUpdate,
  sendMissingReminders,
  sendTabeleReminders,
  sendCoordinatorReports,
} = require("./bot/handlers");
const apiRoutes = require("./api/routes");
const { router: adminRoutes } = require("./api/admin");

const bot = new Telegraf(process.env.BOT_TOKEN);


(async () => {
  await sendCoordinatorReports(bot);
  console.log("Report sent");
  process.exit(0);
})();