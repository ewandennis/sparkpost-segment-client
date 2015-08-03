'use strict';

/*
 * An SP webhook receiver endpoint that translates SP events into equivalent
 * segment.com email semantic events.
 *
 * TODO: license, repo, author
 */

var express = require('express');
var bodyparser = require('body-parser');
var util = require('util');
var winston = require('winston');
var assert = require('assert');
var _ = require('lodash');

// ----------------------------------------------------------------------------

var SEGMENT_API_KEY = '';
var SEGMENT_OPTS = {
  flushAt: 1
};

// ----------------------------------------------------------------------------

// SP event types we want to stream into Segment
var SP_EVENT_CLASSES = ['message_event', 'track_event'];
var SP_EVENT_TYPES = ['reception', 'delivery', 'inband', 'out_of_band', 'feedback', 'open', 'click'];
var SP_FBEVENT_TYPES = ['abuse'];

// Message and recipient fields we want to propagate across events
var SP_IMPORTANT_FIELDS = ['rcpt_to', 'rcpt_meta', 'tags'];

// Map SP event types to Segment.com event types
var SEGMENT_EVENT_TYPES = {
  delivery: 'Email Delivered',
  inband: 'Email Bounced',
  out_of_band: 'Email Bounced',
  feedback: 'Email Marked as Spam',
  open: 'Email Opened',
  click: 'Email Link Clicked'
};

// Load time sanity check
assert(Object.keys(SEGMENT_EVENT_TYPES).filter(function (elt) {
  return SP_EVENT_TYPES.indexOf(elt) < 0;
}).length == 0, 'SP_EVENT_TYPES and SEGMENT_EVENT_TYPES must match');

// ----------------------------------------------------------------------------

// Expects: raw SP webhook event
// Returns: event without the 'msys.message_event' preamble
function unpackSPEvent(evt) {
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
function filterInterestingSPEvents(evt) {
  var unpacked = unpackSPEvent(evt);
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

// ----------------------------------------------------------------------------

// Expects: array of unpacked SP events
// Ensures all SP events have rcpt_to, rcpt_meta and tags fields.
// NOTE: this function drops any events it cannot resolve.
function augmentSPEvents(events, rcptcache, next) {

  // Gather events that are missing any important field
  var fixupevents = events.filter (function (evt) {
    var haveflds = SP_IMPORTANT_FIELDS.filter(function (fldname) {
      return _.has(evt, fldname);
    });

    return (haveflds.length < SP_IMPORTANT_FIELDS.length);
  });

  // Pick out message_id values for each event that needs a fixup
  var fixupmsgids = _.uniq(_.pluck(fixupevents, 'message_id'));

  // Retrieve message details for deficient events
  rcptcache.getMany(fixupmsgids, function (err, results) {
    if (err) {
      return next(err);
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
    var finalevents = events.filter(function (evt) {
      return evt.hasOwnProperty('rcpt_to');
    });

    if (finalevents.length != events.length) {
      winston.info('%d events were dropped due to missing rcpt_to fields.  Did we receive injection events for those messages?',
        events.length - finalevents.length);
    }

    process.nextTick(function() {
      next(null, finalevents);
    });
  });
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

// Expects: array of whole SP events, segment.com API client
// Calls segment.identify() to transfer each event into segment.
// NOTE: this is assumed to be synchronous.
function sendIdentifyEventsToSegment(events, segmentClient) {
  events.forEach(function (evt) {
    segmentClient.identify({
      userId: evt.rcpt_to,
      traits: formatSPMetadataForSegment(evt)
    });
  });
}

// Expects: Array of unpacked SP events, segment client instance
// Delivers each SP event to segment.
// NOTE: this is assumed to be synchronous.
function sendTrackEventsToSegment(events, segmentClient) {
  events.forEach(function (evt) {
    var segeventtype = SEGMENT_EVENT_TYPES[evt['type']];
    if (!segeventtype) {
      winston.warn('Warning: attempted to send SP event with no matching segment event type.  This is a bug.');
      return;
    }

    segmentClient.track({
      // TODO: do we like rcpt_to as userId?
      userId: evt.rcpt_to,
      event: segeventtype,
      properties: {
        // TODO: missing properties: email_body, email_id email_subject, link_url
      },
      context: {
        // TODO: missing context: ip, user_agent
        traits: formatSPMetadataForSegment(evt)
      }
    });
  });
}

// Expects: array of unpacked SP events
// Returns: dictionary of message_id -> rcpt_to, metadata, tags
function mkMessageIdMap(events) {
  // TODO: paranoid mode: each message_id must only map to a single rcpt_to
  return _.zipObject(
    _.zip(
      _.map(events, 'message_id'),
      _.map(events, function (elt) { return _.pick(elt, SP_IMPORTANT_FIELDS); })
    )
  );
}

// ----------------------------------------------------------------------------
// Expects: HTTP request, HTTP response
// Handles 'POST /inbound' traffic from SP webhook service
function handleSPWebhookRequest(req, res) {
  var self = this;

  if (!util.isArray(req.body)) {
    return res.status(500).json({message: 'Array of SparkPost events expected. See www.sparkpost.com/api for details.'});
  }

  // Receive SP events, filter out the uninteresting ones and unpack them
  // for convenience later on.
  // NOTE: unpackSPEvent may produce null entries for invalid events found
  // during unpacking.
  var goodevents = req.body.filter(filterInterestingSPEvents);
  var goodunpacked = goodevents.map(unpackSPEvent);

  winston.debug('%d events in batch', req.body.length);
  winston.debug('%d interesting events', goodevents.length);

  /*
   * Note: SP's delivery, open and click events are missing the rcpt_to field.
   * We compensate by building a message_id => rcpt_to mapping and using it to
   * augment deliveries, opens and clicks.
   */

  // Separate those with rcpt_to from the pack. 
  var splitevts = _.partition(goodunpacked, function (evt) {
    return _.has(evt, 'rcpt_to');
  });
  var rcpttoevts = splitevts[0];
  var anonevts = splitevts[1];

  winston.debug('%d events with rcpt_to field', rcpttoevts.length);
  winston.debug('%d anonymous events', anonevts.length);

  // Form message_id -> rcpt_to mapping from events
  // [ {'000-00000-000-000': 'bob@bob.com'}, ... ]
  var msgidmap = mkMessageIdMap(rcpttoevts);

  // Ensure the recipient cache has all message_id -> rcpt_to mappings
  // available before we start using them to complete the 'anon' events.
  //
  // ASSUMPTION: the first event for a new message_id includes all the
  // important fields.
  //
  winston.debug('Caching new message_ids: ' + JSON.stringify(Object.keys(msgidmap)));
  self.rcptcache.putMany(msgidmap, function (err, newmsgids) {
    if (err) {
      return res.status(500).json({message: err});
    }

    //
    // Call segmentClient.identify() for all email addresses that weren't already
    // in the cache.
    //
    var newmsgevents = rcpttoevts.filter(function (evt) {
      return newmsgids.indexOf(evt.message_id) >= 0;
    });

    winston.debug('%d new message IDs', newmsgids.length);

    augmentSPEvents(goodunpacked, self.rcptcache, function (err, wholeevents) {
      if (err) {
        return res.status(500).json({message: err});
      }

      winston.debug('%d whole events after augmentation', wholeevents.length);

      // All events may have been dropped due to incompleteness.  We still
      // call segment.identify on those with new message_ids and rcpt_to
      // because future event batches could rely upon them.

      // There may be 2 events for a new message_id but we only need a single
      // for each message.
      var identifyevents = _.uniq(newmsgevents, 'message_id');
      sendIdentifyEventsToSegment(identifyevents, self.segmentClient);

      winston.debug('%d segment.identify events sent', identifyevents.length);

      // We have kept injection events up until now to support
      // segment.identify() calls.  We don't track injections though
      // so we drop them here.
      var finalevents = wholeevents.filter(function (evt) { return evt.type != 'reception'; } );

      winston.debug('%d segment.track events sent', finalevents.length);

      // augmentSPEvents() can drop events so we _could_ end up
      // with an empty list here.
      if (finalevents.length == 0) {
        winston.warn('Warning: dropped all incoming events');
      } else {
        sendTrackEventsToSegment(finalevents, self.segmentClient);
      }

      res.json({});
    });
  });
}

exports.App = function(rcptcache, segmentClient) {
  var app = express();

  winston.remove(winston.transports.Console);
  winston.add(winston.transports.Console, { level: 'info' });

  app.use(bodyparser.json({
    limit: 1024 * 1024 * 250
  }));

  app.post('/inbound', handleSPWebhookRequest.bind(app));

  app.rcptcache = rcptcache;

  app.segmentClient = segmentClient;

  app.flushSegmentCache = function (next) {
    segmentClient.flush(next);
  };

  return app;
};

// TODO: if dev environment
exports.utils = {
  SP_EVENT_CLASSES: SP_EVENT_CLASSES,
  SP_EVENT_TYPES: SP_EVENT_TYPES,
  SP_FBEVENT_TYPES: SP_FBEVENT_TYPES,
  unpackSPEvent: unpackSPEvent,
  filterInterestingSPEvents: filterInterestingSPEvents,
  augmentSPEvents: augmentSPEvents,
  formatSPMetadataForSegment: formatSPMetadataForSegment,
  sendIdentifyEventsToSegment: sendIdentifyEventsToSegment,
  sendTrackEventsToSegment: sendTrackEventsToSegment,
  mkMessageIdMap: mkMessageIdMap
};
