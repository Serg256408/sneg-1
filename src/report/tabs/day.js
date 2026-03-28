// day — клиентский JS
const fs = require("fs");
const path = require("path");

function get_day_JS() {
  return fs.readFileSync(path.join(__dirname, "day.client.js"), "utf8");
}

module.exports = { get_day_JS };
