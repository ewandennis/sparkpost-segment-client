var appLib = require('./lib/app').App;
var rcptcacheLib = require('./lib/rcptcache');
var config = require('config');

var segmentLib = require('analytics-node');

// Segment app name: ewan-dennis/spplaytime

var rcptcache = new rcptcacheLib();
var segmentClient = new segmentLib(config.get('segmentAPI.key'), config.get('segmentAPI.opts'));
var app = new appLib(rcptcache, segmentClient);

var server = app.listen(config.get('app.port'), function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log('SparkPost webhook to Segment.com service listening at http://%s:%s', host, port);
});
