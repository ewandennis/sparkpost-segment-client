var config = require('config');
var assert = require('assert');
var util = require('util');
var SegmentClient = require('analytics-node');

var legacyMode = config.get('legacyMode');
var spConfigKey = legacyMode ? 'sparkPostLegacy' : 'sparkPost';
var spConfig = config.get(spConfigKey);

function ensureIsArray(cfgObj, cfgKey, cfgVarKey) {
  assert(util.isArray(cfgObj[cfgVarKey]), cfgKey + '.' + cfgVarKey + ' must be an array');
}

// Init time config sanity checks
ensureIsArray(spConfig, spConfigKey, 'eventClasses');
ensureIsArray(spConfig, spConfigKey, 'eventTypes');
ensureIsArray(spConfig, spConfigKey, 'fbEventTypes');
ensureIsArray(spConfig, spConfigKey, 'importantFields');
assert(typeof spConfig.segmentEventTypeMap == 'object', spConfigKey '.segmentEventTypeMap must be an object');
assert(Object.keys(spConfig.segmentEventTypeMap).filter(function (elt) {
  return config.get(spConfig.eventTypes).indexOf(elt) < 0;
}).length == 0, spConfigKey + '.eventTypes and ' + spConfigKey + '.segmentEventTypeMap must match');

var segmentClient = new SegmentClient(config.get('segmentAPI.key'), config.get('segmentAPI.opts'));
var rcptcache = new require('./lib/rcptcache')();
var spEventFilter = new require('./lib/spevents')(spConfig);
var transform = new require('./lib/transform')(rcptcache, spEventFilter, spConfig, winston);
var load = new require('./lib/load')(segmentClient, spEventFilter, spConfig, winston);
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
