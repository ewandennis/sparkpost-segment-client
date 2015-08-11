'use strict';

var _ = require('lodash');

/*
 * Load conditioned SparkPost events into Segment.com.  See transform.js for conditioning
 * logic.  This module presents an Express middleware interface through Load.prototype.load().
 *
 */

function Load(segmentClient, spEventFilter, appconfig, logger) {
  this.segmentClient = segmentClient;
  this.config = appconfig;
  this.logger = logger;
  this.spEventFilter = spEventFilter;
}

module.exports = Load;

// Express middleware function
Load.prototype.load = function(req, res, next) {
  var self = this;
  self.sendSegmentIdentifyEvents(req.rcpttoevts, req.newmsgids, function (err) {
    if (err) {
      return self.httpErrorHandler(err, req, res);
    }
    self.sendSegmentTrackEvents(req.wholeevents, function (err) {
      if (err) {
        return self.httpErrorHandler(err, req, res)
      }
      next();
    });
  });
}

Load.prototype.flushSegmentCache = function (next) {
  this.segmentClient.flush(next);
};


Load.prototype.httpErrorHandler = function(err, req, res) {
  return res.status(500).json({message: err});
}

// Call segmentClient.identify() for all email addresses that weren't already
// in the cache.
//
// In: rcpttoevts, newmsgids
// Out: -
Load.prototype.sendSegmentIdentifyEvents = function (rcpttoevts, newmsgids, next) {
  var self = this;

  // There may be >1 event for a new message_id but we only need one
  // for each message to trigger an segment.identify() call.
  var newmsgevents = rcpttoevts.filter(function (evt) {
    return newmsgids.indexOf(evt.message_id) >= 0;
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
        traits: self.spEventFilter.formatSPMetadataForSegment(evt)
      };

      self.segmentClient.identify(identcall, function (err, batch) {
        if (err) {
          res.status(500).json({message: err});
          ++callCount;
        } else {
          afterAllCalls(next);
        }
      });
    });
  }

  self.logger.debug('%d segment.identify events sent', identifyevents.length);
}

// Translate conditioned, augmented SP events into their equivalent Segment
// 'track' events.
// In: req.wholeevents
// Out: -
Load.prototype.sendSegmentTrackEvents = function (wholeevents, next) {
  var self = this;

  // We have kept injection events up until now to support
  // segment.identify() calls.  We don't track injections though
  // so we drop them here.
  var trackevents = wholeevents.filter(function (evt) { return evt.type != 'reception'; } );

  // augmentAnonEvents() can drop events so we _could_ end up
  // with an empty list here.
  if (trackevents.length == 0) {
    self.logger.warn('Warning: no events in this batch could be translated into Segment events.');
    next(null);
  } else {

    var callCount = 0;
    var afterAllCalls = function(cb, err, result) {
      if (++callCount == trackevents.length) {
        cb(err, result);
      }
    };

    var segmentEventTypeMap = self.config.get('sparkPost.segmentEventTypeMap');
    for (var i = trackevents.length - 1; i >= 0; i--) {
      var evt = trackevents[i];

      var segeventtype = segmentEventTypeMap[evt['type']];

      if (!segeventtype) {
        self.logger.warn('Warning: attempted to send SP event with no matching segment event type.  This is a bug.');
        afterAllCalls(next, null);
      } else {
        var trackcall = {
          // TODO: do we like rcpt_to as userId?
          userId: evt.rcpt_to,
          event: segeventtype,
          properties: {
            // TODO: missing properties: email_body, email_id email_subject, link_url
            traits: self.spEventFilter.formatSPMetadataForSegment(evt)
          },
          context: {
            // TODO: missing context: ip, user_agent
          }
        };

        self.segmentClient.track(trackcall, function (err, batch) {
            if (err) {
              // BUGBUG: this will break the call sequence in afterAllCalls() if it happens on
              // any event except the last one.
              // res.status(500).json({message: err});
              return next(err);
            } else {
              afterAllCalls(next, null);
            }
        });
      }
    }

    self.logger.debug('%d segment.track events sent', trackevents.length);
  }
}
