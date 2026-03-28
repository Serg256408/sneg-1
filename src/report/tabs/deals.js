// deals — клиентский JS
const fs = require("fs");
const path = require("path");

function get_deals_JS() {
  return fs.readFileSync(path.join(__dirname, "deals.client.js"), "utf8");
}

module.exports = { get_deals_JS };
