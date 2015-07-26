var express = require('express');
var bodyParser = require('body-parser');

// ----------------------------------------------------------------------------

var SEGMENT_API_KEY = '';
var SEGMENT_OPTS = {
  flushAt: 1
};

// ----------------------------------------------------------------------------

module.exports = function(segmentClient) {
  var app = express();

  app.use(bodyParser.json());

  app.flushSegmentCache = function (next) {
    segmentClient.flush(next);
  };

  app.post('/inbound', function (req, res) {
    segmentClient.identify();
    res.json({ok:true});
  });

  return app;
};
