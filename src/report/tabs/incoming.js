// incoming — клиентский JS
const fs = require("fs");
const path = require("path");

function get_incoming_JS() {
  return fs.readFileSync(path.join(__dirname, "incoming.client.js"), "utf8");
}

module.exports = { get_incoming_JS };
