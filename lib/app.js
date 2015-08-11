'use strict';

/*
 * An SP webhook receiver endpoint that translates SP events into equivalent
 * segment.com email semantic events.
 *
 * TODO: license, repo, author
 */

/*
 * Note: SP's delivery, open and click events are missing the rcpt_to field.
 * We compensate by building a message_id => metadata mapping and using it to
 * augment deliveries, opens and clicks.
 */

var express = require('express');
var bodyparser = require('body-parser');
var util = require('util');
var morgan = require('morgan');
var _ = require('lodash');

// ----------------------------------------------------------------------------
// Express middleware
// ----------------------------------------------------------------------------

// The webhooks registration procedure sends a malformed request: {msys:{}}.
// We support that here.
function supportWebhookPings(req, res, next) {
  if (_.isEqual(req.body, {msys:{}})) {
    return res.status(200).json({message:'ok'});
  }
  next();
}

// We expect an array of events
function validateEventArray(req, res, next) {
  if (!util.isArray(req.body)) {
    return res.status(500).json({
      message: 'Array of SparkPost events expected. See www.sparkpost.com/api for details.'
    });
  }
  next();
}

// Empty arrays are ok though.
function shortcutEmptyArray(req, res, next) {
  if (req.body.length == 0) {
    return res.status(200).json({
      message: 'Empty batch detected.  Odd but harmless.'
    });
  }
  next();
}

// ----------------------------------------------------------------------------
// Module interface

// App ctor
module.exports = function (transform, load, rcptcache, config, logger) {
  var app = express();

  app.rcptcache = rcptcache;
  app.config = config;

  logger.remove(logger.transports.Console);
  logger.add(logger.transports.Console, {
    level: app.config.get('logging.level')
  });

  app.use(morgan('combined'));

  app.post('/api/v1/events',
    [
      bodyparser.json({
        limit: app.config.get('app.maxJSONPayloadSize')
      }),
      function (req, res, next) {
          logger.debug(JSON.stringify(req.body, null, '  '));
          next();
      },
      supportWebhookPings,
      validateEventArray,
      shortcutEmptyArray,
      transform,
      load
    ],
    function (req, res) { res.json({}); }
  );

  app.all(function (req, res) {
    res.send(404);
  });

  return app;
};
