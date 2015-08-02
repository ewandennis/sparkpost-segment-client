'use strict';

/*
 * An SP webhook receiver endpoint that translates SP events into equivalent
 * segment.com email semantic events.
 *
 * TODO: license, repo, author
 */

var express = require('express');
var bodyparser = require('body-parser');
var assert = require('assert');
var rcptcache = require('./rcptcache')();
var _ = require('lodash');

// ----------------------------------------------------------------------------

var SEGMENT_API_KEY = '';
var SEGMENT_OPTS = {
  flushAt: 1
};

// ----------------------------------------------------------------------------

// SP event types we want to stream into Segment
var SP_EVENT_CLASSES = ['message_event', 'track_event'];
var SP_EVENT_TYPES = ['delivery', 'bounce', 'out_of_band', 'feedback', 'open', 'click'];
var SP_FBEVENT_TYPES = ['abuse'];

// Map SP event types to Segment.com event types
var SEGMENT_EVENT_TYPES = {
  delivery: 'Email Delivered',
  bounce: 'Email Bounced',
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

// Accepts: array of unpacked SP events
// Ensures all SP events have rcpt_to fields.
// NOTE: this function drops any events it cannot resolve rcpt_tos for.
function augmentSPEvents(events, next) {
  // Gather event types that are missing rcpt_to fields
  var fixupevents = [];
  var fixupmsgids = [];
  var segevents = events.forEach(function (evt) {
    var evttype = evt['type'];
    if (['delivery', 'open', 'click'].indexOf(evttype) >= 0) {
      fixupevents.push(evt);
      fixupmsgids.push(evt.message_id);
    }
  });

  // Retrieve rcpt_tos for deficient SP events
  rcptcache.getMany(fixupmsgids, function (err, results) {
    if (err) {
      return next(err);
    }

    // Fix up SP events with retrieved rcpt_to fields
    fixupevents.forEach(function (evt) {
      if (results.hasOwnProperty(evt.message_id)) {
        evt.rcpt_to = results[evt.message_id];
      }
    });

    // Filter out those still missing a rcpt_to.
    // Events dropped here have message_ids that we have no
    // mapping for.  The most likely situation is that we
    // started receiving events after those messages were sent.
    var finalevents = events.filter(function (evt) {
      return evt.hasOwnProperty('rcpt_to');
    });

    if (finalevents.length != events.length) {
      console.log('Warning: some events were dropped due to missing rcpt_to addresses.  Did we receive injection events for those messages?');
    }

    process.nextTick(function() {
      next(null, finalevents);
    });
  });
}

// Accept: unpacked SP event
// Return: segment traits object
// Merge SP rcpt_meta and tags fields into a single traits dictionary
// NOTE: the returned object shares fields with the SP event object
function formatSPMetadataForSegment(evt) {
  var traits = _.clone(evt.rcpt_meta);
  traits.tags = evt.tags;
  traits.email = evt.rcpt_to;
  return traits;
}

function sendIdentifyEventsToSegment(events, segmentClient) {
  events.forEach(function (evt) {
    segmentClient.identify({
      userId: evt.rcpt_to,
      traits: formatSPMetadataForSegment(evt)
    });
  });
}

// Accepts: Array of unpacked SP events, segment client instance
// Delivers each SP event to segment.
// NOTE: this is assumed to be synchronous.
function sendTrackEventsToSegment(events, segmentClient) {
  events.forEach(function (evt) {
    var segeventtype = SEGMENT_EVENT_TYPES[evt['type']];
    if (!segeventtype) {
      console.log('Warning: attempted to send SP event with no matching segment event type.  This is a bug.');
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

// Accept: array of unpacked SP events
// Return: dictionary of message_id -> rcpt_to
function mkMessageIdMap(events) {
  return _.zipObject(
      _.zip(
        _.map(events, 'message_id'),
        _.map(events, 'rcpt_to')
      )
    );
}

// ----------------------------------------------------------------------------
// Handles 'POST /inbound' traffic from SP webhook service
function handleSPWebhookRequest(req, res) {
  var self = this;

  // Receive SP events, filter out the uninteresting ones and unpack them
  // for convenience later on
  var goodevents = req.body.filter(filterInterestingSPEvents);
  var goodunpacked = goodevents.map(unpackSPEvent);

  /*
   * Note: SP's delivery, open and click events are missing the rcpt_to field.
   * We compensate by building a message_id => rcpt_to mapping and using it to
   * augment deliveries, opens and clicks.
   */

  // Separate those with rcp_to from the pack. 
  var splitevts = _.partition(goodunpacked, function (evt) {
    return _.has(evt, 'rcpt_to') || _.has(evt, 'rcpt_to');
  });
  var rcpttoevts = splitevts[0];
  var anonevts = splitevts[1];

  // Form message_id -> rcpt_to mapping from events
  // [ {'000-00000-000-000': 'bob@bob.com'}, ... ]
  var msgidmap = _.zipObject(
    _.zip(
      _.map(rcpttoevts, 'message_id'),
      _.map(rcpttoevts, 'rcpt_to')
    )
  );

  // Ensure the recipient cache has all message_id -> rcpt_to mappings
  // available before we start using them to complete the 'anon' events.
  rcptcache.putMany(msgidmap, function (err, newmsgids) {
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

    sendIdentifyEventsToSegment(newmsgevents, self.segmentClient);

    augmentSPEvents(goodunpacked, function (err, finalevents) {
      if (err) {
        return res.status(500).json({message: err});
      }

      // augmentSPEvents() can drop events so we _could_ end up
      // with an empty list here.
      if (finalevents.length == 0) {
        console.log('Warning: dropped all incoming events');
      } else {
        sendTrackEventsToSegment(finalevents, self.segmentClient);
      }

      res.json({});
    });
  });
}

exports.App = function(segmentClient) {
  var app = express();

  app.use(bodyparser.json());

  app.post('/inbound', handleSPWebhookRequest.bind(app));

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
