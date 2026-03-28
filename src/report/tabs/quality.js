// quality — клиентский JS
const fs = require("fs");
const path = require("path");

function get_quality_JS() {
  return fs.readFileSync(path.join(__dirname, "quality.client.js"), "utf8");
}

module.exports = { get_quality_JS };
