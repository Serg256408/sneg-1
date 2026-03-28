// manager — клиентский JS
const fs = require("fs");
const path = require("path");

function get_manager_JS() {
  return fs.readFileSync(path.join(__dirname, "manager.client.js"), "utf8");
}

module.exports = { get_manager_JS };
