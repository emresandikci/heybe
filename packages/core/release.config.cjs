const { name } = require("./package.json");

module.exports = {
  ...require("@heybe/configs/release-configs"),
  tagFormat: `${name}@\${version}`,
};
