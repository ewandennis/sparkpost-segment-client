var config = require('config');
var assert = require('assert');
var SegmentClient = require('analytics-node');

// Init time config sanity check
assert(Object.keys(config.get('sparkPost.segmentEventTypeMap').filter(function (elt) {
  return config.get('sparkPost.eventTypes').indexOf(elt) < 0;
}).length == 0, 'eventTypes and segmentEventTypeMap must match');

var segmentClient = new SegmentClient(config.get('segmentAPI.key'), config.get('segmentAPI.opts'));
var rcptcache = new require('./lib/rcptcache')();
var spEventFilter = new require('./lib/spevents')(config);
var transform = new require('./lib/transform')(rcptcache, spEventFilter, config, winston);
var load = new require('./lib/load')(segmentClient, spEventFilter, config, winston);
var app = new require('./lib/app')(
  transform.transform.bind(transform),
  load.load.bind(load),
  rcptcache,
  config,
  winston
);

var server = app.listen(config.get('app.port'), function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log('SparkPost webhook to Segment.com service listening at http://%s:%s', host, port);
});
