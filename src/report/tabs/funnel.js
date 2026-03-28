// funnel — клиентский JS
const fs = require("fs");
const path = require("path");

function get_funnel_JS() {
  return fs.readFileSync(path.join(__dirname, "funnel.client.js"), "utf8");
}

module.exports = { get_funnel_JS };
