'use strict';

var _ = require('lodash');

/*
 * Augment SparkPost events for loading into Segment.com.  This module presents
 * and Express middleware interface through Transform.prototype.transform().
 *
 * SparkPost events don't all include rcpt_to and metdata fields.  This module
 * attempts to cache these fields, indexed by message_id and then augment any
 * events for a given message that are missing those fields.
 *
 * Note: this will become less important as 4.2 style events become the norm.
 */

// TODO: I promise to use promises
function Transform(rcptcache, spEventFilter, appconfig, logger) {
    this.importantFields = appconfig.importantFields;
    this.logger = logger;
    this.rcptcache = rcptcache;
    this.spEventFilter = spEventFilter;
}

module.exports = Transform;

// Express middleware function
Transform.prototype.transform = function (req, res, next) {
  var self = this;
  self.conditionEvents(req.body, function (err, interestingEvents) {
    if (err) {
      return self.httpErrorHandler(err, req, res);
    }
    self.buildMessageIDMap(interestingEvents, function (err, msgidmap, rcpttoevts, anonevts) {
      if (err) {
        return self.httpErrorHandler(err, req, res);
      }
      req.rcpttoevts = rcpttoevts;
      self.cacheMetaDataForNewMessageIDs(msgidmap, function (err, newmsgids) {
        if (err) {
          return self.httpErrorHandler(err, req, res);
        }
        req.newmsgids = newmsgids;
        self.augmentAnonEvents(interestingEvents, function (err, wholeevents) {
          if (err) {
            return self.httpErrorHandler(err, req, res);
          }
          req.wholeevents = wholeevents;
          next();
        });
      });
    });
  });
}

Transform.prototype.httpErrorHandler = function(err, req, res) {
  return res.status(500).json({message: err});
}

// Filter out uninteresting events
// Unpack SP events: remove the 'msys.message_event.' wrapper.
// NOTE: unpackEvent may produce null entries for invalid events found
// during unpacking.
//
// In:  array of raw events
// Out: array of interesting unpacked events
Transform.prototype.conditionEvents = function (allevents, next) {
  var self = this;

  var goodevents = allevents.filter(function (evt) {
    return self.spEventFilter.eventIsInteresting(evt);
  });

  var interestingEvents = _.compact(goodevents.map(function (evt) {
    return self.spEventFilter.unpackEvent(evt);
  }));

  self.logger.debug('%d events in batch', allevents.length);
  self.logger.debug('%d events left after filtering', interestingEvents.length);
  next(null, interestingEvents);
}

// Form a message_id -> (rcpt_to, rcpt_meta, ...) mapping from events with a
// rcpt_to field to allow augmentation of 'anon' events that are missing those fields.
//
// In: array of unpacked events
// Out:
//  msgidmap   - mapping of message_id -> (rcpt_to, rcpt_meta, ...)
//  rcpttoevts - events with rcpt_to field
//  anonevts   - events without rcpt_to field
Transform.prototype.buildMessageIDMap = function (interestingEvents, next) {
  var self = this;

  // Separate those with rcpt_to from the pack. 
  var splitevts = _.partition(interestingEvents, function (evt) {
    return _.has(evt, 'rcpt_to');
  });

  var rcpttoevts = splitevts[0];
  var anonevts = splitevts[1];

  self.logger.debug('%d events with rcpt_to field', rcpttoevts.length);
  self.logger.debug('%d anonymous events', anonevts.length);

  // TODO: paranoid mode: each message_id must only map to a single rcpt_to
  var msgidmap = _.zipObject(
    _.zip(
      _.map(rcpttoevts, 'message_id'),
      _.map(rcpttoevts, function (elt) { return _.pick(elt, self.importantFields); })
    )
  );

  next(null, msgidmap, rcpttoevts, anonevts);
}

// Ensure the recipient cache has all message_id -> metadata mappings
// available before we start using them to complete the 'anon' events.
//
// ASSUMPTION: the first event for a new message_id includes all the
// important fields.
//
// In: msgidmap from buildMessageIDMap()
// Out: array of new message_ids
Transform.prototype.cacheMetaDataForNewMessageIDs = function(msgidmap, next) {
  var self = this;
  self.logger.debug('Caching new message_ids: ' + JSON.stringify(Object.keys(msgidmap)));
  self.rcptcache.putMany(msgidmap, function (err, newmsgids) {
    if (err) {
      return next(err);
       // res.status(500).json({message: err});
    }
    self.logger.debug('%d new message IDs', newmsgids.length);
    next(null, newmsgids);
  });
}

// Ensure all events have rcpt_to, rcpt_meta and tags fields.
// NOTE: this function drops any events it cannot augment.
//
// In: array of unpacked events
// Out: array of 'whole' events that include SP_IMPORTANT_FIELDS
Transform.prototype.augmentAnonEvents = function (interestingEvents, next) {
  var self = this;

  // Gather events that are missing any important field
  var fixupevents = interestingEvents.filter (function (evt) {
    var haveflds = self.importantFields.filter(function (fldname) {
      return _.has(evt, fldname);
    });

    return (haveflds.length < self.importantFields.length);
  });

  // Pick out message_id values for each event that needs a fixup
  var fixupmsgids = _.uniq(_.pluck(fixupevents, 'message_id'));

  // Retrieve message details for deficient events
  self.rcptcache.getMany(fixupmsgids, function (err, results) {
    if (err) {
      next(err);
      // return res.status(500).json({message: err});
    }

    // Fix up SP events with retrieved fields where possible
    var wheatchaff = _.partition(fixupevents, function (evt) {
      return _.has(results, evt.message_id)
    });

    var fixableevents = wheatchaff[0];

    self.logger.debug('Fixing up %d events', fixableevents.length);

    fixableevents.map(function (evt) {
      var fixer = results[evt.message_id];
      self.logger.debug('Fixing ' + evt.type + ' event with id ' +
        evt.message_id + '.  New fields will be ' + JSON.stringify(fixer));
      _.extend(evt, fixer);
    });

    if (wheatchaff[1].length > 0) {
      self.logger.warn('%d anonymous events were received for which we have no metadata',
        wheatchaff[1].length);
    }

    // Filter out those events still missing at least the rcpt_to field.
    // Events dropped here have message_ids that we have no mapping for.
    // The most likely situation is that we started receiving events
    // after those messages were sent.
    var wholeevents = interestingEvents.filter(function (evt) {
      return evt.hasOwnProperty('rcpt_to');
    });

    if (wholeevents.length != interestingEvents.length) {
      self.logger.info('%d events were dropped due to missing rcpt_to fields.  Did we receive injection events for those messages?',
        interestingEvents.length - wholeevents.length);
    }

    self.logger.debug('%d whole events after augmentation', wholeevents.length);

    next(null, wholeevents);
  });
}

