// stats — клиентский JS
const fs = require("fs");
const path = require("path");

function get_stats_JS() {
  return fs.readFileSync(path.join(__dirname, "stats.client.js"), "utf8");
}

module.exports = { get_stats_JS };
