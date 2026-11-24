'use strict';
// The one place the JS tests learn where the app is. PAGE holds the browser files (served at the same URLs, from app/page/).
const path = require('path');
exports.APP = path.join(__dirname, '..', 'app');
exports.PAGE = path.join(exports.APP, 'page');
