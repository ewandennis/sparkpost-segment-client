var config = require('config');
var assert = require('assert');
var util = require('util');
var winston = require('winston');
var SegmentClient = require('analytics-node');

var RcptCache = require('./lib/rcptcache');
var SPEventFilter = require('./lib/spevents');
var Transform = require('./lib/transform');
var Load = require('./lib/load');
var App = require('./lib/app');

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
assert(typeof spConfig.segmentEventTypeMap == 'object', spConfigKey + '.segmentEventTypeMap must be an object');
assert(Object.keys(spConfig.segmentEventTypeMap).filter(function (elt) {
  return spConfig.eventTypes.indexOf(elt) < 0;
}).length == 0, spConfigKey + '.eventTypes and ' + spConfigKey + '.segmentEventTypeMap must match');

var segmentClient = new SegmentClient(config.get('segmentAPI.key'), config.get('segmentAPI.opts'));
var rcptcache = new RcptCache();
var spEventFilter = new SPEventFilter(spConfig);
var transform = new Transform(rcptcache, spEventFilter, spConfig, winston);
var load = new Load(segmentClient, spEventFilter, spConfig, winston);
var app = new App(
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
