const { name } = require("./package.json");

module.exports = {
  ...require("@heybejs/configs/release-configs"),
  tagFormat: `${name}@\${version}`,
};
