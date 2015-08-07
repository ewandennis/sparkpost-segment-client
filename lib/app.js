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
var config = require('config');
var winston = require('winston');
var assert = require('assert');
var morgan = require('morgan');
var _ = require('lodash');

// ----------------------------------------------------------------------------
// These are the SP event classes, types and subtypes we want to stream into Segment

var SP_EVENT_CLASSES;
var SP_EVENT_TYPES;
var SP_FBEVENT_TYPES;

// SP event fields we want to propagate across events
var SP_IMPORTANT_FIELDS;

// Map SP event types to Segment.com event types
var SEGMENT_EVENT_TYPES;

// ----------------------------------------------------------------------------
// SP event munging utilities
// ----------------------------------------------------------------------------

// Expects: raw SP webhook event
// Returns: event without the 'msys.message_event' preamble
function unpackEvent(evt) {
  var rec = evt.msys;
  if (!rec) {
    return null;
  }

  var type = SP_EVENT_CLASSES.filter(rec.hasOwnProperty.bind(rec));
  if (type.length == 0) {
    return null;
  }

  return rec[type[0]];
}

// An Array.filter() predicate for events this service cares about.
// Expects: raw SP webhook event
// Returns: true/false
function eventIsInteresting(evt) {
  var unpacked = unpackEvent(evt);
  if (!unpacked) {
    return false;
  }

  var evttype = unpacked['type'];

  if (SP_EVENT_TYPES.indexOf(evttype) < 0) {
    return false;
  }

  if (evttype == 'feedback' && SP_FBEVENT_TYPES.indexOf(unpacked.fbtype) < 0) {
    return false;
  }

  return true;
}

// Expects: unpacked SP event
// Returns: segment traits object
// Merge SP rcpt_meta and tags fields into a single traits dictionary
// NOTE: the returned object shares fields with the SP event object
function formatSPMetadataForSegment(evt) {
  var traits = {
    email: evt.rcpt_to
  };

  if (_.has(evt, 'rcpt_meta')) {
    _.extend(traits, evt.rcpt_meta);
  }

  if (_.has(evt, 'tags')) {
    traits.tags = _.clone(evt.tags);
  }

  return traits;
}

// ----------------------------------------------------------------------------
// Express middleware
// ----------------------------------------------------------------------------

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

// Filter out uninteresting events
// Unpack SP events: remove the 'msys.message_event.' wrapper.
// NOTE: unpackEvent may produce null entries for invalid events found
// during unpacking.
//
// In: req.body - array of raw events
// Out: req.interestingEvents - array of interesting unpacked events
function conditionEvents(req, res, next) {
  var goodevents = req.body.filter(eventIsInteresting);
  req.interestingEvents = _.compact(goodevents.map(unpackEvent));
  winston.debug('%d events in batch', req.body.length);
  next();
}

// Form a message_id -> (rcpt_to, rcpt_meta, ...) mapping from events with a
// rcpt_to field to allow augmentation of 'anon' events that are missing those fields.
//
// In: req.body - array of unpacked events
// Out:
//  req.rcpttoevts - events with rcpt_to field
//  req.anonevts   - events without rcpt_to field
//  req.msgidmap   - mapping of message_id -> (rcpt_to, rcpt_meta, ...)
function buildMessageIDMap(req, res, next) {

  // Separate those with rcpt_to from the pack. 
  var splitevts = _.partition(req.interestingEvents, function (evt) {
    return _.has(evt, 'rcpt_to');
  });
  req.rcpttoevts = splitevts[0];
  req.anonevts = splitevts[1];

  winston.debug('%d events with rcpt_to field', req.rcpttoevts.length);
  winston.debug('%d anonymous events', req.anonevts.length);

  // TODO: paranoid mode: each message_id must only map to a single rcpt_to
  req.msgidmap = _.zipObject(
    _.zip(
      _.map(req.rcpttoevts, 'message_id'),
      _.map(req.rcpttoevts, function (elt) { return _.pick(elt, SP_IMPORTANT_FIELDS); })
    )
  );

  next();
}

// Ensure the recipient cache has all message_id -> metadata mappings
// available before we start using them to complete the 'anon' events.
//
// ASSUMPTION: the first event for a new message_id includes all the
// important fields.
//
// In: req.msgidmap
// Out: req.newmsgids - array of new message_ids
function cacheMetaDataForNewMessageIDs(req, res, next) {
  winston.debug('Caching new message_ids: ' + JSON.stringify(Object.keys(req.msgidmap)));
  req.app.rcptcache.putMany(req.msgidmap, function (err, newmsgids) {
    if (err) {
      return res.status(500).json({message: err});
    }
    req.newmsgids = newmsgids;
    winston.debug('%d new message IDs', req.newmsgids.length);
    next();
  });
}

// Ensure all events have rcpt_to, rcpt_meta and tags fields.
// NOTE: this function drops any events it cannot augment.
//
// In: req.body - array of unpacked events
// Out: req.wholeevents - array of 'whole' events (including SP_IMPORTANT_FIELDS)
function augmentAnonEvents(req, res, next) {

  // Gather events that are missing any important field
  var fixupevents = req.interestingEvents.filter (function (evt) {
    var haveflds = SP_IMPORTANT_FIELDS.filter(function (fldname) {
      return _.has(evt, fldname);
    });

    return (haveflds.length < SP_IMPORTANT_FIELDS.length);
  });

  // Pick out message_id values for each event that needs a fixup
  var fixupmsgids = _.uniq(_.pluck(fixupevents, 'message_id'));

  // Retrieve message details for deficient events
  req.app.rcptcache.getMany(fixupmsgids, function (err, results) {
    if (err) {
      return res.status(500).json({message: err});
    }

    // Fix up SP events with retrieved fields where possible
    var wheatchaff = _.partition(fixupevents, function (evt) { return _.has(results, evt.message_id)});
    var fixableevents = wheatchaff[0];

    winston.debug('Fixing up %d events', fixableevents.length);

    fixableevents.map(function (evt) {
      var fixer = results[evt.message_id];
      winston.debug('Fixing ' + evt.type + ' event with id ' + evt.message_id + '.  New fields will be ' + JSON.stringify(fixer));
      _.extend(evt, fixer);
    });

    if (wheatchaff[1].length > 0) {
      winston.warn('%d anonymous events were received for which we have no metadata',
        wheatchaff[1].length);
    }

    // Filter out those events still missing at least the rcpt_to field.
    // Events dropped here have message_ids that we have no mapping for.
    // The most likely situation is that we started receiving events
    // after those messages were sent.
    var wholeevents = req.interestingEvents.filter(function (evt) {
      return evt.hasOwnProperty('rcpt_to');
    });

    if (wholeevents.length != req.interestingEvents.length) {
      winston.info('%d events were dropped due to missing rcpt_to fields.  Did we receive injection events for those messages?',
        req.interestingEvents.length - wholeevents.length);
    }

    req.wholeevents = wholeevents;

    winston.debug('%d whole events after augmentation', req.wholeevents.length);

    next();
  });
}

// Call segmentClient.identify() for all email addresses that weren't already
// in the cache.
//
// In: req.rcpttoevts
// Out: -
function sendSegmentIdentifyEvents(req, res, next) {
  // There may be >1 event for a new message_id but we only need one
  // for each message to trigger an segment.identify() call.
  var newmsgevents = req.rcpttoevts.filter(function (evt) {
    return req.newmsgids.indexOf(evt.message_id) >= 0;
  });
  var identifyevents = _.uniq(newmsgevents, 'message_id');

  var callCount = 0;
  var afterAllCalls = function (cb) {
    if (++callCount == identifyevents.length) {
      cb();
    }
  };

  if (identifyevents.length == 0) {
    next();
  } else {
    identifyevents.forEach(function (evt) {
      var identcall = {
        userId: evt.rcpt_to,
        traits: formatSPMetadataForSegment(evt)
      };

      req.app.segmentClient.identify(identcall, function (err, batch) {
        if (err) {
          res.status(500).json({message: err});
          ++callCount;
        } else {
          afterAllCalls(next);
        }
      });
    });
  }

  winston.debug('%d segment.identify events sent', identifyevents.length);
}

// Translate conditioned, augmented SP events into their equivalent Segment
// 'track' events.
// In: req.wholeevents
// Out: -
function sendSegmentTrackEvents(req, res, next) {
  // We have kept injection events up until now to support
  // segment.identify() calls.  We don't track injections though
  // so we drop them here.
  var trackevents = req.wholeevents.filter(function (evt) { return evt.type != 'reception'; } );

  // augmentAnonEvents() can drop events so we _could_ end up
  // with an empty list here.
  if (trackevents.length == 0) {
    winston.warn('Warning: no events in this batch could be translated into Segment events.');
    next();
  } else {

    var callCount = 0;
    var afterAllCalls = function(cb) {
      if (++callCount == trackevents.length) {
        cb();
      }
    };

    trackevents.forEach(function (evt) {

      var segeventtype = SEGMENT_EVENT_TYPES[evt['type']];

      if (!segeventtype) {
        winston.warn('Warning: attempted to send SP event with no matching segment event type.  This is a bug.');
        afterAllCalls(next);
        return;
      }

      var trackcall = {
        // TODO: do we like rcpt_to as userId?
        userId: evt.rcpt_to,
        event: segeventtype,
        properties: {
          // TODO: missing properties: email_body, email_id email_subject, link_url
          traits: formatSPMetadataForSegment(evt)
        },
        context: {
          // TODO: missing context: ip, user_agent
        }
      };

      req.app.segmentClient.track(trackcall, function (err, batch) {
          if (err) {
            res.status(500).json({message: err});
            ++callCount;
          } else {
            afterAllCalls(next);
          }
      });
    });

    winston.debug('%d segment.track events sent', trackevents.length);
  }
}

// ----------------------------------------------------------------------------
// Module interface

// App ctor
function App(rcptcache, segmentClient) {
  var app = express();

  app.rcptcache = rcptcache;
  app.segmentClient = segmentClient;
  app.flushSegmentCache = function (next) {
    segmentClient.flush(next);
  };

  winston.remove(winston.transports.Console);
  winston.add(winston.transports.Console, {
    level: config.get('logging.level')
  });

  loadConfig();

  app.use(morgan('combined'));

  app.post('/api/v1/events',
    [
      bodyparser.json({
        limit: config.get('app.maxJSONPayloadSize')
      }),
      validateEventArray,
      shortcutEmptyArray,
      conditionEvents,
      buildMessageIDMap,
      cacheMetaDataForNewMessageIDs,
      augmentAnonEvents,
      sendSegmentIdentifyEvents,
      sendSegmentTrackEvents
    ],
    function (req, res) { res.json({}); }
  );

  app.all(function (req, res) {
    res.send(404);
  });

  return app;
};

exports.App = App;

// Cache various config variables
function loadConfig() {
  SP_EVENT_CLASSES = config.get('sparkPost.eventClasses');
  SP_EVENT_TYPES = config.get('sparkPost.eventTypes');
  SP_FBEVENT_TYPES = config.get('sparkPost.fbEventTypes');
  SP_IMPORTANT_FIELDS = config.get('sparkPost.importantFields');
  SEGMENT_EVENT_TYPES = config.get('sparkPost.segmentEventTypeMap');

  if (process.env.NODE_ENV != 'production') {
    exports.utils.SP_EVENT_CLASSES = SP_EVENT_CLASSES;
    exports.utils.SP_EVENT_TYPES = SP_EVENT_TYPES;
    exports.utils.SP_FBEVENT_TYPES = SP_FBEVENT_TYPES;
  }

  // Init time config sanity check
  assert(Object.keys(SEGMENT_EVENT_TYPES).filter(function (elt) {
    return SP_EVENT_TYPES.indexOf(elt) < 0;
  }).length == 0, 'SP_EVENT_TYPES and SEGMENT_EVENT_TYPES must match');
}

exports.loadConfig = loadConfig;

// Expose some internals for testing purposes
if (process.env.NODE_ENV != 'production') {
  exports.utils = {
    unpackEvent: unpackEvent,
    eventIsInteresting: eventIsInteresting,
    formatSPMetadataForSegment: formatSPMetadataForSegment,
  };
}
