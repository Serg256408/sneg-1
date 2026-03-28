// shared — клиентский JS
const fs = require("fs");
const path = require("path");

function get_shared_JS() {
  return fs.readFileSync(path.join(__dirname, "shared.client.js"), "utf8");
}

module.exports = { get_shared_JS };
