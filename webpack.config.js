const path = require('path');

module.exports = {
  entry: './web/client.js',
  output: {
    filename: 'client.js',
    path: path.resolve(__dirname, 'web/public'),
  },
};