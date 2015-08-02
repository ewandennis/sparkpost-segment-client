var appLib = require('./lib/app').App;
var segment = require('analytics-node');

// ewan-dennis/spplaytime
var SEGMENT_API_KEY = 'lWium4ksh4OkAah8AhB8rbYgL08z5xvV';
var SEGMENT_OPTS = {};

var segmentClient = segment(SEGMENT_API_KEY, SEGMENT_OPTS);
var app = new appLib(segmentClient);

var server = app.listen(3000, function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Example app listening at http://%s:%s', host, port);
});
