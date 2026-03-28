// daily — клиентский JS
const fs = require("fs");
const path = require("path");

function get_daily_JS() {
  return fs.readFileSync(path.join(__dirname, "daily.client.js"), "utf8");
}

module.exports = { get_daily_JS };
