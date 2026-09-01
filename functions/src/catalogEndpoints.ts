// index.ts deploys `exports.catalog` from this file, not from catalog.ts:
// requiring catalog.ts directly would deploy every other export it has
// (the pure helpers the tests and adminCatalog use) as its own function.
const catalog = require("./catalog");

exports.create = catalog.create;
exports.ensureauthors = catalog.ensureauthors;
exports.search = catalog.search;
exports.workreaders = catalog.workreaders;
