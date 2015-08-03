var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');

var expect = chai.expect;

var rcptcachelib = require('../lib/rcptcache');

var MESSAGE_ID1 = 'fb238d87-deaf-427e-91e6-da675ecea2a4';
var OBJECT1 = {
	rcpt_to: 'bob@jimbob.co.kr',
	rcpt_meta: {
		first_name: 'bob',
		surname: 'jimbob',
	},
	tags: ['male', 'fictitious']
};

var MESSAGE_ID2 = 'fb238d87-deaf-feed-beef-da675ecea2a4';
var OBJECT2 = {
	rcpt_to: 'jim@bobaroo.co.il',
	rcpt_meta: {
		first_name: 'jim',
		surname: 'bobaroo'
	},
	tags: ['male', 'totallyreal']
}

function makePutMap() {
	var map = {};
	map[MESSAGE_ID1] = OBJECT1;
	map[MESSAGE_ID2] = OBJECT2;
	return map;
}

var rcptcache = new rcptcachelib();

describe('Recipient cache', function () {
	describe('#put', function() {
		it('should accept a message ID key and object value', function (done) {
			rcptcache.put(MESSAGE_ID1, OBJECT1, function (err) {
				expect(err).to.be.null;
				done();
			});
		});
	});

	describe('#putMany', function() {
		it('should accept a map containing message ID -> object pairs', function (done) {
			rcptcache.putMany(makePutMap(), function (err) {
				expect(err).to.be.null;
				done();
			});
		});
	});

	describe('#putMany', function() {
		it('should return a list of newly added message IDs', function (done) {
			var emptycache = new rcptcachelib();
			emptycache.putMany(makePutMap(), function (err, newids) {
				expect(err).to.be.null;
				expect(newids).to.deep.equal([MESSAGE_ID1, MESSAGE_ID2]);
				var fullcache = new rcptcachelib();
				var putmap1 = {};
				var putmap2 = {};
				putmap1[MESSAGE_ID1] = OBJECT1;
				putmap2[MESSAGE_ID2] = OBJECT2;
				fullcache.putMany(putmap1, function (err1, newids1) {
					expect(err1).to.be.null;
					expect(newids1).to.deep.equal([MESSAGE_ID1]);
					fullcache.putMany(putmap2, function (err2, newids2) {
						expect(err2).to.be.null;
						expect(newids2).to.deep.equal([MESSAGE_ID2]);
						fullcache.putMany(makePutMap, function (err3, newids3) {
							expect(err3).to.be.null;
							expect(newids3).to.deep.equal([]);
							done();
						});
					});
				});
			});
		});
	});

	describe('#get', function () {
		it('should retrieve the object associated with a given message ID', function (done) {
			rcptcache.put(MESSAGE_ID1, OBJECT1, function (err) {
				expect(err).to.be.null
				rcptcache.get(MESSAGE_ID1, function (err2, result) {
					expect(err2).to.be.null;
					expect(result).to.deep.equal(OBJECT1);
					done();
				});
			});
		});
	});

	describe('#getMany', function () {
		it('should retrieve the set of objects associated with given message IDs', function (done) {
			var putMap = makePutMap();
			rcptcache.putMany(putMap, function (err) {
				expect(err).to.be.null;
				rcptcache.getMany(Object.keys(putMap), function (err, result) {
					expect(err).to.be.null;
					expect(result).to.deep.equal(putMap);
					done();
				});
			})
		});
	});
});
