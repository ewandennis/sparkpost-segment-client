var _ = require('lodash');

/*
 * Map message IDs to a dictionary of message and recipient fields.
 * Note: this impl is unsafe in production.  This must be backed by durable storage
 * with intelligently chosen record expiry times.
 */

module.exports = function() {
  return {
  	cache: {},

    put: function(msgid, obj, next) {
    	this.cache[msgid] = obj;
    	process.nextTick(_.partial(next, null));
    },

    putMany: function(records, next) {
    	var self = this;
        var cachemsgids = Object.keys(self.cache);
        var inmsgids = Object.keys(records);

        var newids = _.difference(inmsgids, cachemsgids);

        inmsgids.forEach(function (msgid) {
    		self.cache[msgid] = records[msgid];
    	});
    	process.nextTick(_.partial(next, null, newids));
    },

    get: function(msgid, next) {
    	var self = this;
    	process.nextTick(function () {
    		next(null, self.cache[msgid]);
    	});
    },

    getMany: function(msgids, next) {
        var self = this;
        var result = {};
        msgids.forEach(function (msgid, idx) {
            result[msgid] = self.cache[msgid];
        });
        process.nextTick(function () {
            next(null, result);
        });
    }
  };
}
